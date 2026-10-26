# feat/hooks-turn — `turn_start` context, `turn_end` (may continue), `model_request` notification

> **Status:** feat — promoted 2026-10-22. Owner decisions D2, D8 in the umbrella; R1–R4 decided 2026-10-21. Implementation approved.
> **Branch:** `feat/hooks-turn`
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing (the end-of-turn no-await invariant, history validity, **protocol bump 8 → 9**) · **Review:** mandatory fresh-context
> **Umbrella:** [`extensibility.md`](../eval/extensibility.md) (child 3 of 5) · **Needs:** `hooks-core` merged ✓ (config key, `stdin`, `HookRunner`)

## Context

*— claude-opus-5-5, 2026-10-21*

### The question

Hooks at the turn's boundaries and before each model call:

| Event | When | Hook may return | Awaited? |
|---|---|---|---|
| `turn_start` | once per turn, after the user's message (and `/skill` round), before the first model call | `context` (text injected as a note), or exit 2 = stop the turn | yes |
| `turn_end` with `end_turn` | the model answered without tool calls | `continue` + `reason` (inject, run another round; max 3 per turn) | yes |
| `turn_end` with `cancelled` / `max_iterations` | the turn stops for another reason | nothing (notification) | **no** (fire-and-forget) |
| `model_request` | before **every** model call (D2: notification, read-only, local only) | nothing | **no** |

> Note (`docs/feat/session-titles.md`, owner Q3): "every model call" means every
> call of the **agent loop**. The daemon's session-title request (one short,
> tool-less call after the first exchange) is not an agent-loop round and fires
> **no** `model_request` hook.

### State today (verified against `main` @ 399ea0b)

| Fact | Evidence |
|---|---|
| **End-of-turn invariant**: from the last steering drain to the `turn_end` yield there must be **no `await`**, explicitly "no end-of-turn hook". Pinned by a daemon test | `agent/src/agent.ts:455-470`; `daemon/test/integration.test.ts:401` ("no macrotask fits between the last steering drain and the turn's end") |
| The `toolCalls.length === 0` branch: late-steer drain → empty-round nudge (`MAX_EMPTY_CONTINUES = 2`) → `turn_end{end_turn}` | `agent/src/agent.ts:456-494`, constant `:90` |
| `max_iterations` path: a final no-tools model call, then a drain, then `turn_end{max_iterations}` (same invariant) | `agent/src/agent.ts:500-579` |
| Turn start order: resumed round → user `/skill` round → background-exit notes → loop | `agent/src/agent.ts:357-379` |
| Model calls: `this.config.model.stream(request)` in the loop, plus the final no-tools stream | `agent/src/agent.ts:401`, `:532` |
| The loop's own user-role injections emit `context_note` right after the push, so replay can rebuild them | `agent/src/agent.ts:484-491` (nudge), `:696-712` (background); event type `:137-143` |
| `context_note.reason` is a **closed enum** `["continue", "background_exit"]` on the wire | `protocol/src/updates.ts:92-96` |
| `context_note` is a `display` update, but the *field value* is validated by zod: a new value breaks an old client's parse | `protocol/src/updates.ts:166-182` (class), `:92-96` (enum) |
| Reverse mappings pass `reason` through | `daemon/src/mapping.ts:171-172`; `client/src/mapping.ts:171-172` |
| The TUI and the plain renderer render `context_note` as **nothing** | `tui/src/state.ts:309-315`; `cli/src/render.ts:38-40` |
| `PROTOCOL_VERSION = 7` | `protocol/src/version.ts:7` |
| In a pod the agent's provider is a `ProxyModelProvider` (`buildAgent` `modelOverride`); locally and in plain `serve` it is the real provider | `cli/src/serve.ts:240-262`; `cli/src/wiring.ts:103-104` |

**Repro (2026-10-21, `main` @ 399ea0b):** the invariant comment that forbids
an awaited end-of-turn hook at the obvious place:

```
$ git show main:packages/agent/src/agent.ts | sed -n 459,462p
        // INVARIANT: from this drain to the `turn_end` yield (and on through the
        // daemon's `HostedSession.finishTurn` clearing its controller and fanning
        // `turn_end` out to every attached client, never awaited) there must be
        // NO `await` — no end-of-turn hook, no async persist. (`serve`'s
```

### Decisions

- **R2 — DECIDED (owner, 2026-10-21):** at most **3** `turn_end` continues
  per turn.
- **R1 — DECIDED (owner, 2026-10-21):** hook notes are **visible** in the TUI, dimmed, prefixed
  `[hook]`. A user must see what their hooks injected.
- **R3 — DECIDED (owner, 2026-10-21):** `model_request` back-pressure: if the previous
  notification for the same session is still running, **drop** the new one
  (one log line per drop burst). Never queue.
- **R4 — DECIDED (owner, 2026-10-21):** `turn_start` does **not** fire on a resumed turn
  (`resumeFrom`): it already started before the restart.

## Implementation

*— claude-opus-5-5, 2026-10-21 (draft; approved at promotion)*

### Load-bearing assumption

An awaited `turn_end` hook placed **before** the late-steering drain keeps
the invariant. The invariant forbids awaits only *from the drain to the
`turn_end` yield* (`agent.ts:459-470`). Anything queued while the hook runs
is drained right after it. Prove it before writing the hook: add to
`daemon/test/integration.test.ts` a variant of the `:401` test where a
`turn_end` hook takes 50 ms, and assert the same property (an enqueue during
the hook is either drained into the turn or rejected `NoTurnRunning`, never
accepted-and-dropped).

### Preconditions

- `hooks-core` merged: `HookRunner`, `HookSpec` with all 5 events,
  `ExecOptions.stdin`.
- History validity: a user-role note at a turn or iteration boundary is
  already a valid history shape (steering and background notes do exactly
  that, `agent.ts:375-389`). `docs/eval/history-validity-invariant.md` asks
  for a test; the tests below include one.

### Design

#### Note text and protocol

Every hook-injected user-role message is
`[hook ${event}] ${text}` (like the existing `[background] …` note,
`agent.ts:705`). It is pushed into `messages`, then followed by
`yield { type: "context_note", text, reason: "hook" }`.

- `AgentEvent` `context_note.reason` gains `"hook"` (`agent.ts:142`).
- Protocol `ContextNoteSchema.reason`: `z.enum(["continue", "background_exit", "hook"])`
  (`protocol/src/updates.ts:95`).
- **`PROTOCOL_VERSION` 7 → 8** (`protocol/src/version.ts:7`): a new enum
  value breaks an old client's parse. AGENTS §7: a breaking change bumps, so
  a mixed pair fails cleanly at `initialize`. If `hooks-project-trust` lands
  in the same release window, it shares this bump (it needs none of its
  own: its new method is additive).
- Regenerate the exported protocol JSON schema with `bun run schema:export`
  (writes `packages/protocol/schema/protocol.json`, `docs/feat/protocol-schema-export.md`) and commit the
  diff.
- Mappings pass `reason` through unchanged (`daemon/src/mapping.ts:172`,
  `client/src/mapping.ts:172`); only the types widen.
- TUI (R1): `tui/src/state.ts` `context_note` case → when
  `reason === "hook"`, append a dim note item (reuse an existing dim/system
  item kind if one exists; otherwise add `{ kind: "note", text }` rendered by
  `render-lines.ts` with `theme.subtle`). Other reasons stay invisible.
  Plain renderer (`cli/src/render.ts:39`): `hook` → `\n[hook] ${text}\n`.

#### `turn_start`

In `runMessages`, **after** the background-exit flush (`agent.ts:375-377`)
and **before** the `for` loop (`:379`), only when `opts.resumeFrom ===
undefined` (R4) and `hooks?.hasAny("turn_start")`:

```ts
const start = await this.config.hooks.turnStart({ sessionId, prompt: lastUserText(messages), signal });
for (const note of start.notes) { messages.push({ role: "user", content: note }); yield { type: "context_note", text: note, reason: "hook" }; }
if (start.stop) { /* exit 2, or onFailure:block failure */
  const text = `[hook turn_start] turn stopped: ${start.reason}`;
  messages.push({ role: "user", content: text });
  yield { type: "context_note", text, reason: "hook" };
  yield { type: "turn_end", reason: "end_turn" };
  return;
}
```

- `lastUserText`: the content of the last `role: "user"` message (string
  content; `""` if none).
- Each matching hook's `context` produces **one** note. Run sequentially, in
  config order.
- Ending with only a user-role note is valid: the next turn appends another
  user message. Check against the history-validity test.

#### `turn_end` that may continue (R2: max 3)

Inside `if (toolCalls.length === 0) {` (`agent.ts:456`), as the **first**
statement, **before** `const late = drainSteering?.() ?? [];` (`:471`):

```ts
const stalled = text.trim() === "" && emptyRounds < MAX_EMPTY_CONTINUES;
if (!stalled && this.config.hooks?.hasAny("turn_end") && hookContinues < MAX_HOOK_CONTINUES) {
  const end = await this.config.hooks.turnEnd({
    sessionId, reason: "end_turn", lastAssistantMessage: text, continued: hookContinues, signal,
  });
  if (signal?.aborted) { yield { type: "turn_end", reason: "cancelled" }; return; }
  if (end.continue) {
    hookContinues++;
    const note = `[hook turn_end] ${end.reason}`;
    messages.push({ role: "user", content: note });
    yield { type: "context_note", text: note, reason: "hook" };
    continue; // next iteration; counts toward maxIterations
  }
}
// existing code from here on, unchanged: drain → nudge → turn_end (NO await)
```

- `const MAX_HOOK_CONTINUES = 3;` next to `MAX_EMPTY_CONTINUES`;
  `let hookContinues = 0;` next to `emptyRounds`.
- Skipped on a stalled (empty) round: the existing nudge handles that, and a
  hook should judge a real answer.
- `end.continue` is true if **any** matching hook returned
  `{"continue": true}` or exited 2. `reason` = the reasons joined with
  `"\n"` (exit 2 → stderr; empty → `"continue"`).
- Hook input adds `reason`, `last_assistant_message`, `continued` (0–2).
- At the cap the hook is **not run** (it cannot continue anyway). The turn
  ends normally.

#### `turn_end` notifications (`cancelled`, `max_iterations`)

At each `yield { type: "turn_end", reason: "cancelled" | "max_iterations" }`,
call `this.notifyTurnEnd(sessionId, reason)` immediately before the yield.
It is a **non-async** method that does
`void this.config.hooks?.turnEndNotify(...)` (never awaited, errors caught
and logged inside the runner). Being synchronous, it keeps the invariant at
the `max_iterations` path (`:572-578`). Do not add it to the `end_turn`
yield (that path already ran the awaited hook above).

#### `model_request` (D2: notification, read-only, local only)

- Enabled only when the daemon calls the provider **itself**, i.e. `buildAgent`
  got **no** `modelOverride` (`cli/src/wiring.ts:104`). In a pod
  (`serve --stdio --model-proxy`, `cli/src/serve.ts:240`) the request is
  built in the untrusted pod; audit belongs on the laptop (follow-up eval).
  `HookRunnerOptions` gains `modelRequestHooks: boolean`; wiring passes
  `options.modelOverride === undefined`.
- Call site: `this.notifyModelRequest(sessionId, iteration, request)`
  (non-async, fire-and-forget) right before `this.config.model.stream(request)`
  at `agent.ts:401` and before the final stream at `:532` (iteration =
  `"final"`).
- Input: `{ iteration, model, message_count, tool_names, new_messages }`.
  - `model`: the configured model id. Add `modelId` to
    `HookRunnerOptions`, from `config.model`.
  - `new_messages`: the messages appended since the previous
    `model_request` of the same session, each `{ role, content }` where
    `content` is the string content (non-string → `JSON.stringify`). The
    runner keeps `Map<sessionId, number>` (last count). After a compaction
    shrinks the history, the count is reset (`count > messages.length` →
    send all).
  - The messages are the request's own, as the model receives them: a
    message carrying a context line has it rendered into `content`
    (`[context: …]`, docs/feat/context-awareness.md).
- R3: at most one in flight per session; a call arriving while one runs is
  dropped (log once per burst).

#### Runner additions (`agent/src/hooks.ts`)

```ts
turnStart(i: { sessionId; prompt; signal? }): Promise<{ notes: string[]; stop: boolean; reason: string }>;
turnEnd(i: { sessionId; reason: "end_turn"; lastAssistantMessage; continued; signal? }): Promise<{ continue: boolean; reason: string }>;
turnEndNotify(i: { sessionId; reason: "cancelled" | "max_iterations" }): Promise<void>; // never throws
notifyModelRequest(i: { sessionId; iteration: number | "final"; messages: readonly ChatMessage[]; toolNames: readonly string[] }): void; // never throws
```

Outcome tables (pure parsers, as in `hooks-core`):

| Outcome | `turn_start` | `turn_end` (end_turn) | notify events |
|---|---|---|---|
| exit 0, empty | no note | stop | ignored |
| exit 0, `{"context": "…"}` | one note | — | ignored |
| exit 0, `{"continue": true, "reason": "…"}` | — | continue | ignored |
| exit 2 | stop the turn (reason = stderr) | continue (reason = stderr) | ignored |
| failure, `onFailure: "ignore"` | no note + log | stop + log | log |
| failure, `onFailure: "block"` | stop the turn | continue (reason = "hook failed: …") | log |

### Files (dependency order)

1. `packages/protocol/src/updates.ts`, `packages/protocol/src/version.ts`, then `bun run schema:export` (`packages/protocol/schema/protocol.json`)
2. `packages/agent/src/hooks.ts`, `packages/agent/src/agent.ts`
3. `packages/daemon/src/mapping.ts` (types only), `packages/client/src/mapping.ts` (types only)
4. `packages/cli/src/wiring.ts` (`modelRequestHooks`, `modelId`), `packages/cli/src/render.ts`
5. `packages/tui/src/state.ts` (+ `render-lines.ts` if a new item kind)
6. tests (below)

### Failure modes

| Case | Convergence |
|---|---|
| A slow `turn_end` hook + a user enqueue meanwhile | the hook is before the drain: the message is drained and runs another round. The new integration test pins it |
| A hook that always continues | capped at 3 per turn (R2) and by `maxIterations`. With `maxIterations: -1` the cap of 3 still holds |
| Cancel during a `turn_start` / `turn_end` hook | the signal kills the hook; then `turn_end{cancelled}` (the explicit abort check after `turnEnd`; the loop top handles `turn_start`) |
| Old client meets `reason: "hook"` | prevented by the bump: clean `VersionMismatch` at `initialize` |
| Resume / re-attach replay | the note is a `ChatMessage` + `context_note`, so it replays like the existing notes |
| `/resume` of a saved session | notes are user-role messages starting `[hook …]`, recognisable in the transcript |
| `model_request` hook stuck | not awaited; R3 drops overlapping calls; the process is killed at its timeout |
| `model_request` in a pod | not run (`modelRequestHooks: false`); documented |
| Sub-agents | the child's runner (`forAgent`) runs `turn_start` / `turn_end` for the child's own run with `agent` set (H2); the child's continue cap is separate |
| No hooks | `hasAny` false → no awaits are added; every path identical. Existing suites pin it |

### Tests (red before green, §9)

- `daemon/test/integration.test.ts`: the `:401` property with a 50 ms
  `turn_end` hook (fake env whose `exec` sleeps). **Mutation check:** move
  the hook call after the drain → the test must fail.
- `agent/test/hooks-turn.test.ts` (new; `ScriptedProvider` + fake env):
  - `turn_start` context → a user message `[hook turn_start] …` precedes the
    first model request (assert on the provider's received `messages`) and a
    `context_note{reason:"hook"}` event is yielded;
  - `turn_start` exit 2 → no model call, the turn ends `end_turn` with the
    note;
  - `turn_end` continue → a second model round runs; after 3 continues the
    4th `end_turn` ends the turn (the hook ran exactly 3 times);
  - `turn_end` not run on an empty (stalled) round;
  - `cancelled` / `max_iterations` notify → the hook `exec` is called, and
    `turn_end` is yielded without awaiting it (an `exec` that never resolves
    must not hang the test);
  - `model_request`: called once per model call with correct
    `new_messages` deltas; not called when `modelRequestHooks: false`; a
    second call while the first hangs is dropped;
  - R4: no `turn_start` on `resumeFrom`.
- History validity: after each hook path, the history passes the repo's
  validity check (or, if none exists yet, assert the role sequence
  explicitly).
- `protocol`: `ContextNoteSchema` accepts `"hook"`; the version is 8.
- `tui/test/state.test.ts`: a `context_note{reason:"hook"}` appends a
  visible note; other reasons do not.

Gate: `bun run check` green.

## Execution

*— claude-opus-5-5, 2026-10-22*

**Repro (capability missing, before any edit)**, `.tentacle/tmp/hooks-turn/repro.ts`:
an `Agent` with a `HookRunner` holding `turn_start` / `turn_end` /
`model_request` specs, and a fake env that records every `exec`:

```
$ bun .tentacle/tmp/hooks-turn/repro.ts
hook execs: [] model calls: 1 events: text,turn_end
```

**As built, in order:**

1. `agent/test/hooks-turn.test.ts` (new, 18 tests) was written first.
   `parseTurnStartOutcome` / `parseTurnEndOutcome` / `modelRequestDelta` were
   added as typed stubs, so that 17/18 went red **on their assertions** (the
   18th, "not run when `modelRequestHooks` is false", is a negative and is
   pinned by mutation M5 below).
2. `agent/src/hooks.ts`: the pure parsers `parseTurnStartOutcome` (:203),
   `parseTurnEndOutcome` (:225) and `modelRequestDelta` (:255), plus
   `hookNote`. Also `HookRunnerOptions.modelId` / `modelRequestHooks`, and
   the runner methods `turnStart` (:424), `turnEnd` (:458),
   `turnEndNotify` (:495) and `notifyModelRequest` (:510). The last has an
   R3 per-session busy set, a one-log-per-burst drop, and a per-session
   message count.
3. `agent/src/agent.ts`: `MAX_HOOK_CONTINUES = 3` (:93), `lastUserText`
   (:101), the `turn_start` block after the background flush (:405), the
   `turn_end` hook as the first statement of the no-tool-calls branch,
   **before** the late drain (:511), and `notifyModelRequest` before both
   streams (:445, :614). `notifyTurnEnd` (non-async, :662) is called before
   every `cancelled` yield (7 sites) and before the `max_iterations` yield.
   `context_note.reason` gains `"hook"`. Agent tests: 18/18 green.
4. **Mutation checks**: 13 mutations, each caught (≥ 1 test red). M1 exit 2 →
   stop. M2 no shrink reset in the delta. M3 block failure → none. M4 no
   `context` type check. M5 ignore `modelRequestHooks`. M6 no R3 drop. M7 no
   `"continue"` default reason. M8 cap 4. M9 hook run on a stalled round. M10
   no R4 guard. M11 no abort check after `turnEnd`. M12 no `max_iterations`
   notify. M13 no `"final"` notify.
5. **Load-bearing test** `daemon/test/integration.test.ts`: "a slow
   turn_end hook: an enqueue during it is drained, and no macrotask fits
   after the last drain". The hook `exec` sleeps 50 ms; a `HostedSession.enqueue`
   fires 10 ms into it. The test asserts a `steer` echo, a second round
   (hook ran twice), the last drain's next macrotask
   `{running:false, ended:true}`, and the final update `turn_end{end_turn}`.
   **Red** with `agent.ts` from HEAD (no steer). **Red** with the doc's
   mutation (the hook block moved after the drain).
6. Protocol: `ContextNoteSchema.reason` + `"hook"`, `PROTOCOL_VERSION` 8 → 9,
   and `bun run schema:export` (`protocol.json`, 2 lines). A new test in
   `protocol/test/updates.test.ts` was red (the old enum rejected `"hook"`),
   then green.
7. Renderers: `tui/src/state.ts` turns a `context_note{reason:"hook"}` into
   the existing dim `notice` item (`appendNotice`), and other reasons stay
   invisible. `cli/src/render.ts` prints `hook` → `\n${text}\n`. Both tests
   were red, then green.
8. `cli/src/wiring.ts`: `modelId: config.model`,
   `modelRequestHooks: options.modelOverride === undefined`. The new
   `cli/test/wiring.test.ts` test runs real processes: `turn_start` context
   arrives, and a `model_request` hook does **not** run under a
   `modelOverride`. Mutation (`modelRequestHooks: true`) → red.
9. Docs: the README `### Hooks` section is extended (turn events,
   `model_request`, notes, `block` semantics), and the stale "accepted but
   not run yet" text is gone from the README and from `config/src/defaults.ts`.
10. Gate: `bun run check`: typecheck clean; lint 0/0 (363 files); **1713
    pass, 2 skip (the opt-in ones), 0 fail** (1715 tests, 149 files). The new
    hook tests were run 5× more with no flake.

**Drift from Implementation:**

- **Version 8 → 9, not 7 → 8.** `PROTOCOL_VERSION` was already 8 on `main`
  (59fed44, `/mcp` panel), after this plan was written at 399ea0b. The rule
  (breaking ⇒ bump) is applied as written. `protocol/test/mcp.test.ts`
  pinned `toBe(8)`, so it is now `toBeGreaterThanOrEqual(8)`. The new test
  pins 9.
- `daemon/src/mapping.ts` and `client/src/mapping.ts` were **not edited**:
  their types are inferred, and `tsc` is clean with the widened union.
- The `turn_start` `prompt` is captured at the start of `runMessages`, before
  the `/skill` round and the background notes. `lastUserText(messages)` at
  the hook site could otherwise return a `[background]` note instead of the
  user's prompt.
- The notes are rendered as-is (`[hook turn_end] …`), not `[hook] ${text}`.
  The text already carries the `[hook <event>]` prefix (R1), so the plain
  renderer prints `\n${text}\n` and the TUI reuses the dim `notice` item
  (no new item kind, `render-lines.ts` untouched).
- `parseTurnStartOutcome`: a whitespace-only `context` is no note. A
  `turn_end` hook killed by cancel makes `turnEnd` return
  `{continue:false}` right away (the agent then ends `cancelled`).
- `notifyTurnEnd` also fires on the 6 pre-existing `cancelled` yields: the
  loop top, the stream catch, the post-stream abort, the post-cap abort, and
  the two in the final stream. That is "each yield" per the Design.

**Known limits (not verified / left):** `forAgent` copies `modelId`, so a
sub-agent whose type overrides the model reports the parent's id in
`model_request`. The `model_request` positive path is tested at the agent
level (fake env), not through `buildAgent` without an override, because
that would call the real provider.

### Post-review fixes

*— claude-opus-5-5, 2026-10-22* (review: REQUEST-CHANGES; Review section untouched)

1. **Steer lost on a `turn_start` stop.** A `session/enqueue` accepted while
   `await hooks.turnStart` ran was dropped, because the stop branch yielded
   `turn_end` without draining. The stop branch now drains just before
   `turn_end`, with no await in between. Each drained steer is pushed as a
   user message and echoed (`steer` event), then the turn ends `end_turn`
   with **no model round**: the stop holds, and a steer must not reach the
   model without passing `turn_start`. (An earlier fix gave it a round; the
   re-review flagged that as a policy bypass.)
   - History is valid: the stop already ends on a user-role note, so a steer
     adds one more user message, and the next `send` appends after
     consecutive user messages exactly as after a plain stop. The
     `max_iterations` post-report drain already leaves the same shape.
   - Daemon test: "a slow turn_start hook that stops the turn: an enqueue
     during it is kept and echoed, but gets no model round" (exit 2 after
     50 ms, enqueue at 10 ms). It asserts the steer echo, 0 model calls, an
     empty `pendingSteering()`, and the steer as the last message.
   - Red with no drain (steer `[]`), red with the "gets a round" code
     (`modelCalls` 1), then green.
2. **Sub-agent model id.** `HookRunner.forAgent(agent, modelId?)`, and
   `subagent.ts` passes `type.model`. New test in `subagent.test.ts`: a child
   with `model: "child-m"` reports `child-m` and a plain one reports
   `parent-m`. It was red before the fix, then green.
3. **Cap test.** `RecordingProvider` now throws after 8 calls. With the cap
   check removed, both cap tests fail fast with "runaway" instead of hanging.
4. **Doc metadata.** The metadata line and `TODO.md` now read protocol 8 → 9.
5. **Context bound.** `turn_start` `context` is clipped at `MAX_HOOK_CONTEXT`
   = 10 000 chars. It gets a larger bound than `MAX_REASON` because a context
   is legitimately bigger. Its test was red, then green.
6. **README.** It now says that a resumed turn gets a fresh cap of 3. It also
   documents the drain on a stop and the context clip.
7. **Debt (not fixed):** after `/resume`, `tui/src/resume.ts:17` rebuilds
   every user-role message, `[hook …]` notes included, as a plain `user`
   item, not a dim notice. The loop's other notes (the nudge, `[background]`)
   behave the same today. Recognising notes on rebuild is a follow-up.
8. **Comment wrap.** The `ContextNoteSchema` doc comment is re-wrapped.

## Review

*— claude-opus-5-5, 2026-10-22 — fresh-context adversarial review. The executor is the **same model** (claude-opus-5-5), only a fresh context: shared blind spots can survive both passes; AGENTS §10 prefers a different model for a load-bearing task.*

**Verdict: REQUEST-CHANGES** (one must-fix: the `turn_start` stop path reopens the accepted-and-dropped steering window this task exists to keep closed).

### Findings

**Must-fix**

1. **`turn_start` stop drops an accepted steer** — `packages/agent/src/agent.ts:404-421`.
   `await hooks.turnStart(...)` runs while the turn is live (`HostedSession.enqueue`
   accepts, `daemon/src/hosted-session.ts:799`), then the `start.stop` branch yields
   `turn_end{end_turn}` with **no drain**. The queued text stays in
   `Session.pendingSteering()` and the next `send` resets the queue
   (`agent/src/session.ts:82`): silently lost — the exact failure the invariant
   comment at `:533-545` forbids. Proven by trace A below (`enqueue: ACCEPTED`, no
   `steer` update, `pending steering: ["late steer"]`). Change: in the stop branch,
   after the note and *synchronously* before the `turn_end` yield, `drainSteering?.()`
   and push + `yield {type:"steer"}` each text (kept in history, ends the turn as
   stopped — or, if the owner prefers, fall into the loop); then add a daemon
   integration test mirroring the `turn_end` one (slow exit-2 `turn_start` hook,
   enqueue at 10 ms ⇒ a `steer` echo, nothing left pending, last-drain macrotask
   `{running:false, ended:true}`), red on the current code.
2. **Sub-agent `model_request` reports the parent's model** (unverified item a — confirmed)
   — `agent/src/hooks.ts:352-357` (`forAgent` spreads `this.opts`, `modelId`
   included) with `agent/src/subagent.ts:164-175` (the child's `type.model`
   override is ignored). An audit hook gets a silently wrong `model`. Change:
   `forAgent(agent, modelId?)` overriding `modelId`, and pass `type.model` at
   `subagent.ts:175` when set; one agent-level test.

**Nits**

3. `agent/test/hooks-turn.test.ts:276-311` — the `maxIterations: -1` cap test **hangs**
   (not fails) when the cap is removed (mutation M1 ran >7 min / 8 GB, killed).
   Bound it (a scripted provider that throws past N calls, or an iteration guard) so
   a regression is a red test, not a hung suite.
4. Stale "protocol 7 → 8": this doc's metadata line and `TODO.md:640` — now 8 → 9.
5. `turn_start` `context` is not clipped (`hooks.ts` `parseTurnStartOutcome`; up to
   1 MiB per hook per turn into history) while `turn_end` reasons clip at
   `MAX_REASON`. Clip it, or document it.
6. The continue cap is per `runMessages` call: a resumed turn (`resumeFrom`) gets a
   fresh 3. Acceptable (resume is rare and bounded), but say so in the README/doc.
7. `/resume` renders hook notes as plain user items (`tui/src/resume.ts:17`), not the
   dim notice they are live (R1). Same as the pre-existing nudge/background notes;
   track as debt.
8. `protocol/src/updates.ts:89` — the doc-comment line is unwrapped (>100 cols).

### Rulings on the executor's drift / unverified items

- **8 → 9 and `mcp.test.ts` → `toBeGreaterThanOrEqual(8)`: accepted.** That test's
  property is "the `/mcp` change bumped past 7"; `≥ 8` is that property exactly, and
  the exact pin (`toBe(9)`) moved to `protocol/test/updates.test.ts`.
- **Mappings unedited: accepted.** Both pass `reason` through
  (`daemon/src/mapping.ts:219-220`, `client/src/mapping.ts:186-187`) and are typed by
  the widened union; `tsc` clean.
- **`prompt` captured before the notes: accepted** (better than the plan:
  `lastUserText` at the hook site could return a `[background]` note).
- **Note format `[hook <event>] …` rendered verbatim: accepted** (carries R1's prefix).
- **(a)** confirmed as finding 2. **(b)** positive `model_request` only at agent level:
  **accepted** — the wiring line is `modelRequestHooks: options.modelOverride === undefined`
  (`cli/src/wiring.ts:171`) and its negative is pinned with real processes and a
  mutation; the positive is covered by the agent tests.

### Gate (re-run by the reviewer)

`bun run check`: typecheck clean; lint `Checked 363 files`, 0 errors / 0 warnings;
**1713 pass, 2 skip (the two opt-in), 0 fail — 1715 tests, 149 files.** Matches Execution.

### Premise table

| Premise | Verdict |
|---|---|
| Context symptom: no turn/model hooks run (repro `hook execs: []`) | TRUE on HEAD (the executor's repro; the README/defaults said "accepted but not run") |
| No-await invariant from the late drain to `turn_end` (`agent.ts:533-545` now) | TRUE |
| `HostedSession.enqueue` accepts only while a turn runs; next `send` resets the queue | TRUE (`hosted-session.ts:791-804`, `session.ts:82`) — the basis of finding 1 |
| `context_note.reason` was a closed enum; bump needed | TRUE (`updates.ts:95`); version was **8** on `main`, not 7 (plan premise FALSE, drift handled) |
| Mappings pass `reason` through | TRUE |
| TUI/plain renderer hid `context_note` | TRUE |
| `modelOverride` ⇔ pod model tunnel | TRUE (`wiring.ts`, `serve.ts`) |
| "A user-role note at a boundary is a valid history shape" | TRUE; trace B roles `uauauaua`; an empty stalled assistant is dropped by the Anthropic mapping (`anthropic-provider.ts:333`) |

### Mutation non-vacuity (reviewer's own, tree byte-identical afterwards — `git diff` sha checked)

| Mutation | Result |
|---|---|
| M1 cap removed (`&& hookContinues < MAX_HOOK_CONTINUES`) | caught by the `maxIterations 16` case, but the `-1` case **hangs** → nit 3 |
| M2 the `turn_end` hook block moved after the late drain | **1 fail** (the new daemon integration test) |
| M3 no `notifyTurnEnd` before `max_iterations` | **1 fail** |
| M4 `turn_end` continue note yielded but not pushed to history | **2 fail** |

### Attacks tried

1. **Steer during the awaited `turn_start` hook, stop path** → **found finding 1** (trace A).
2. **Steer during the awaited `turn_end` hook** → holds: hook precedes the drain; the
   new integration test pins it and fails under M2.
3. **Always-continue hook with `maxIterations: -1`, plus steer** → holds: 3 hook runs,
   4 model calls, `turn_end{end_turn}`, roles `uauauaua` (trace B); a steer does not
   reset `hookContinues`. Continue on the last iteration falls to the `max_iterations`
   final call (history ends in a user note — valid).
4. **Throwing notifications** (`void turnEndNotify`, `notifyModelRequest` IIFE) → holds:
   `run()` catches everything (`hooks.ts:581-596`), no unhandled rejection path; both
   call sites are non-async, so the `max_iterations` path keeps the invariant.
5. **Hung hook** → `turn_end`/`turn_start` bounded by the spec timeout (default 600 s)
   and killed by cancel (abort check after `turnEnd`); notifications are never awaited
   and R3 drops overlap. No deadlock path; the turn stays "running" (steerable) while it waits.
6. **Persistence** → notes are `ChatMessage`s + `context_note` (right choice: the model
   must see them next round, and snapshot/replay/resume stay consistent); no new await
   near `finishTurn`/`persister.schedule`.
7. **Peer serialization / pod trust** → no transport change; awaits live in the agent
   generator, not RPC handlers. `model_request` off under `modelOverride` (pod); hook
   notes from a pod are pod-supplied history like the rest of the conversation and are
   display-only on the laptop (no laptop-side effect, no approval created).

### End-to-end trace (`.tentacle/tmp/hooks-turn/review-trace.ts`, real `HostedSession` + `Agent` + `HookRunner`, fake env/provider)

```
A enqueue: ACCEPTED
A updates: turn_start context_note([hook turn_start] turn stopped: nope) turn_end(end_turn)
A model calls: 0 pending steering: ["late steer"]
B hook runs: 3 model calls: 4 events: text context_note(hook) text context_note(hook) text context_note(hook) text turn_end(end_turn)
B roles: uauauaua
```

### What holds

The `turn_end` placement (before the drain) and its daemon test; the cap across steer
and `maxIterations: -1`; history alternation; protocol bump with schema export and both
ends; renderers (TUI dim notice, plain text); pod gating of `model_request`; no-hooks
path unchanged (no added awaits when `hasAny` is false).

### How the executor behaved

Disciplined: tests first, 13 self-mutations, honest drift and known-limits sections, and
it flagged both unverified items itself. It missed that the new `turn_start` await has
its own end-of-turn exit (the stop branch) — it red-teamed the planned site, not every
path to `turn_end`.

### Re-review

*— claude-opus-5-5, 2026-10-22 (same reviewer context; same model as the executor)*

**Verdict: REQUEST-CHANGES** (one narrow must-fix, R-1; everything else is resolved).

- **Gate:** `bun run check` green: typecheck clean, lint 0/0 (363 files),
  **1716 pass, 2 skip (opt-in), 0 fail — 1718 tests, 149 files.**
- **Trace A re-run** (`.tentacle/tmp/hooks-turn/review-trace.ts`): `enqueue: ACCEPTED`,
  then `context_note … steer(late steer) agent_message_chunk turn_end(end_turn)`,
  `pending steering: []`. The steer is no longer lost (finding 1 is fixed as a loss).
  Trace B is unchanged (3 hook runs, roles `uauauaua`).
- **Mutations (tree byte-identical afterwards):** removing the stop-path drain → the new
  daemon test fails; dropping `type.model` at `subagent.ts:178` → the new sub-agent test fails;
  removing the cap → 3 fails in about 1 ms (no hang: nit 3 is fixed). Findings 2–8 are resolved.
- **R-1 (must-fix): a stopped turn must not run a model round** — `agent/src/agent.ts:414-427`.
  A `turn_start` stop (exit 2 or a `block` failure) is a veto: the turn does not run.
  Giving the drained steer a round contradicts that, and it lets a steer sent during the
  hook reach the model **without ever passing `turn_start`**. That bypasses a policy hook,
  such as a prompt filter or a freeze window, simply by typing while it runs. The normal
  late-drain path differs because there the turn was allowed. Change: keep the synchronous
  drain, push each steer and yield its `steer` event (so it is in the history, replayable,
  never dropped), then `yield turn_end{end_turn}` and `return` without a model round.
  The next user turn carries it and runs `turn_start` on its own prompt. Update the daemon
  test to assert the `steer` echo, **no** model call, and an empty pending queue.

**Final verdict: APPROVE.** *— claude-opus-5-5, 2026-10-22.* R-1 is fixed (`agent.ts:414-430`):
trace A shows `steer(late steer) turn_end(end_turn)` with 0 model calls and an empty
queue. The "gets a round" mutation fails the daemon test, and the tree was byte-identical
afterwards. `bun run check`: 1716 pass, 2 skip (opt-in), 0 fail (1718 tests), lint 0/0.
The flaky `session-reaper.test.ts` "a connection forgets a session…" is **not plausibly
this branch**. It never runs a turn and configures no hooks, and the branch's agent
changes are all guarded by `hooks?.` (no-ops without a runner). It asserts collection
through `WeakRef` + `Bun.gc(true)` with 5 × 5 ms retries, which makes it GC-timing
sensitive under full-suite load. It passed 8/8 when run alone. Track it as pre-existing
test debt.
