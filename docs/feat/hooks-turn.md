# feat/hooks-turn — `turn_start` context, `turn_end` (may continue), `model_request` notification

> **Status:** feat — promoted 2026-10-22. Owner decisions D2, D8 in the umbrella; R1–R4 decided 2026-10-21. Implementation approved.
> **Branch:** `feat/hooks-turn`
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing (the end-of-turn no-await invariant, history validity, **protocol bump 7 → 8**) · **Review:** mandatory fresh-context
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

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-21*

Self-review. The load-bearing point is the end-of-turn invariant. The only
safe slot for an awaited `turn_end` hook is before the drain, and the plan
both places it there and pins it with a mutation-checked test. This child
carries the protocol bump (7 → 8) that the umbrella's first draft missed.
