# fix/think-tag-leak — a stray `</think>` and a doubled answer in a Qwen reply, caused by echoing last turn's reasoning

> **Status:** implementation — APPROVED (owner decision 2026-11-25)
> **Branch:** `fix/think-tag-leak`
> **Type:** fix · **Size:** S · **Blast:** contained (one provider's request builder; no protocol, no persistence) · **Suited:** Sonnet/DeepSeek exec, standard in-context Review
> **Changelog:** `changelog.d/think-tag-leak.fixed.md`

## Context

*— claude-sonnet-5-5, 2026-11-25*

**Problem.** A Qwen reply (llama.cpp, `unsloth/Qwen3.8-27B-UD-Q6_K_XL`) stored by tentacle carries a stray `</think>` and the answer twice: `No: 391 = 17 × 23, quindi è composto.\n</think>\n\nNo: 391 = …`. Seen on turn 2 of a session, the first turn with an echoed `reasoning` in history (fix/reasoning-echo). Direct non-streaming requests without tentacle's request shape did not reproduce it.

**Reproduced: YES — 6/12 two-turn tentacle runs, turn 2 only (turn 1: 0/12).** The stray tag is in the **RAW SSE stream of the server** (`delta.content`), before any tentacle parsing: **model/server behaviour, triggered by what tentacle sends — not a tentacle parsing bug.**

**Repro** (2026-11-25, `fix/think-tag-leak` = `8d29dd10`, `~/bin/tentacle` binary of the day, in `.tentacle/tmp/think-tag-leak/`, gitignored — scripts summarised here):
- `proxy.ts`: a Bun proxy on `127.0.0.1:18080` → `http://192.168.1.17:8080`. It reads the real key at runtime from the serve config and injects it (the key is in no file); it saves each full request body (`NNNN.req.json`) and the RAW response bytes (`NNNN.raw`).
- `drive.sh`: `TENTACLE_CONFIG_DIR=<tmp>/cfg` (a config with `baseURL` = the proxy, dummy key); per run a fresh cwd and `tentacle --plain` fed on stdin (there is no `-p`): turn 1 «Rispondi in una riga, senza usare strumenti: quanto fa 17 × 23, e in che giorno della settimana cade il 25 novembre 2026?», turn 2 (same session, sent after turn 1's stream ended) «E 391 è primo? Rispondi in una riga.». 12 runs = 24 calls. Every request: stream, `stream_options.include_usage`, 12 tools, the full system prompt, a `[context: …]` suffix on each user message, `reasoning_content` on the turn-1 assistant message (turn 2 only).
- `an.ts` on the raw files: `</think>` in `delta.content` of calls 4, 6, 10, 14, 22, 26 (all turn 2) = 6/12; in `reasoning_content`: 0; turn 1 (no echo in history): 0/12. The tentacle `out.txt` shows the tag in the same 6 runs.

Raw excerpt of call 0004 (turn 2), SSE chunks in order (`r` = `reasoning_content`, `c` = `content`):
```
r " number"  r "."                              ← reasoning ends: "…therefore it's a composite number." (no </think> seen in reasoning)
c "No" c ":" c " " … c " composto" c "."        ← draft answer, as content
c "\n</think>"                                   ← the stray tag, one content delta
c "\n\nNo" c ":" … c " composto."                ← the real answer, again
```
Content as concatenated from the wire: `'No: 391 = 17 × 23, quindi è composto.\n</think>\n\nNo: 391 = 17 × 23, quindi è composto.'` — the model re-opens a think/answer pattern after the server already switched to content; tentacle only stores what it receives.

**Bisect** (the captured call-0004 request replayed straight to the server, key at runtime; `bisect.ts`; stray `</think>` in the final content; streamed unless noted):

| variant | hits / n |
|---|---|
| baseline (the exact tentacle request) | 9/32 (28%) (+ tentacle's own 6/12) |
| **no `reasoning_content` on history messages** | **0/12** |
| **no `tools`** | **0/32** |
| no system prompt | 3/32 |
| no tools + no system | 0/12 |
| non-streaming (`stream:false`) | 9/32 → same rate as streaming, not a stream-parser artefact |
| no `[context: …]` suffix | 2/12 |

`/apply-template` of the same request (`tmpl-echo.txt` vs `tmpl-noecho.txt`): with the echo, the **prior-turn** assistant message is rendered as a full `<think>\n<whole reasoning>\n</think>\n\n<answer>` (the reasoning ends with a draft of the answer line); without it, as an empty `<think>\n\n</think>`. So the trigger is: reasoning of an EARLIER turn (before the last user message) echoed into history, with tools in the request (the template's tool-mode path).

**Not proved:** the exact mechanism inside llama.cpp/Qwen (the model imitating the "draft, `</think>`, answer" shape it sees in the history, vs. the server's reasoning parser closing early). It does not matter for the fix: removing the earlier-turn echo removes the trigger (0/12 and 0/32 are the controls; baseline rate 28% → p(0/12 | same rate) ≈ 2%).

## Implementation

*— claude-sonnet-5-5, 2026-11-25*

### Load-bearing assumption

fix/reasoning-echo's benefit comes from WITHIN-turn rounds (a tool loop: the model sees its own reasoning on the next request of the same turn). Reasoning of turns that are already finished is not needed — vendors drop it themselves (Qwen's own template renders earlier turns' thinking empty, as seen in `tmpl-noecho.txt`; DeepSeek/Anthropic docs say only the current tool-use turn's reasoning must be passed back). **Unverified for tentacle:** the F8 bench proxy echoed ALL earlier assistant messages (docs/fix/reasoning-echo.md, Context), so no number separates the two. Cheapest check before merge: the stale-taskrun arm on DeepSeek with the earlier-turn echo off, compared with the 4.7 min / 20k-token result — a single-turn task, so it should be identical by construction (nothing earlier than the turn exists).

### Preconditions

- The echo is decided per message in `toWireMessage(message, options, echoSource)` → `ownOpenAIReasoning` (`packages/providers/src/openai-provider.ts:612,650,501`), fed from `wireMessages` (`:555-586`) and `buildPayload` (`:517-523`). The `echoing` flag that guards the 400-retry (`:317-319`) is computed by scanning ALL messages → must use the same cut, or a harmless retry path stays armed with nothing to drop.
- Anthropic has the same per-message call (`anthropic-provider.ts:603`); the API already ignores earlier turns' thinking, so it is NOT changed here (out of the symptom).
- AGENTS §7: nothing persisted changes (`ChatMessage.reasoning` stays in the log, only the wire view is cut); no protocol field; the pod path (`ProxyModelProvider`) sends the same `ChatMessage`s to the laptop provider, which applies the cut — one place.

### Design

A pure helper (providers package, React-free, unit-tested): `echoFloor(messages): number` = the index of the last `user` message that STARTS a turn; reasoning is echoed only for assistant messages at an index ≥ that floor. `wireMessages` passes `echoSource` only for those messages; the `echoing` pre-scan uses the same helper.

**Open point, resolved by the executor — the floor CANNOT skip a steer** (plan
fix, see Execution): a mid-turn steer IS pushed as a bare
`{ role: "user", content: steer }` (`packages/agent/src/agent.ts:1568`), and no
marker exists anywhere to tell it from the user message that opened the turn —
not on `ChatMessage` (`packages/core/src/model.ts:33-139`), and not in the log,
which persists a steer as a plain user message (AGENTS §7: `steer` is a
rendering-only event, never written). Skipping it would need a new field on
`ChatRequest` — which crosses `model/stream` on the wire (`packages/protocol/src/model.ts`)
and would break this task's `contained` blast for a case no measurement
separates. Adopted rule, one sentence: **reasoning is echoed only for assistant
messages after the last `user` message, steer or not** — the echo covers the
current segment. It is safe-directional (it can only ever drop echo, never
re-introduce the earlier-turn echo that triggers the stray tag), and it costs at
most the tail of a turn that a person steered.

**Plan fix 2 — the cut is gated on the request offering tools.** The Context's
bisect is the reason: `no tools` → 0/32 hits, i.e. the leak lives in the
template's TOOL-mode path, and the echo's measured win (F8) is a tool loop. So
`echoFloor(messages, tools)` returns 0 (no cut, the pre-fix bytes) when
`tools` is empty/absent, and the last-user index when tools are offered. Without
this gate the cut also lands on the ONE request the loop builds by hand — the
forced final report, which appends a tentacle-written `user` nudge and offers no
tools (`packages/agent/src/agent.ts:2006-2025`) — and a capped single-turn run
would stop being byte-identical, contradicting the load-bearing check above and
flipping the existing regression test
(`packages/agent/test/reasoning-echo.test.ts:147-166`). With the gate, that test
passes unchanged and pins the no-tools arm.

Rejected: (a) stripping `</think>` from `content` — the output already doubles the answer, a strip leaves a half-fixed reply and treats a symptom, and would need retraction in the live stream; (b) never echo on OpenAI-compatible endpoints — throws away the measured win; (c) a llama.cpp request flag — none known, and endpoint-specific.

**Defensive layer (optional, decide with the owner):** with the trigger removed no stray tag is expected; if one still appears (another model/server), a post-stream normaliser "content containing `</think>` ⇒ keep the text after the last one, move the text before it to reasoning" could be added. Not proposed now: it needs a retraction path in the stream and there is no repro left to pin it.

### Files

1. `packages/providers/src/openai-provider.ts` — the helper + `wireMessages` + the `echoing` scan (`:317-319`).
2. `packages/providers/test/reasoning-echo-openai.test.ts` — new cases (below).
3. `changelog.d/think-tag-leak.fixed.md` — one bullet.

### Failure modes

- Single-turn tool loop (the F8 case): all assistant messages are after the floor → unchanged behaviour. The forced final report of a CAPPED turn offers no tools, so the gate above leaves it byte-identical too (0/32 in the bisect).
- Steer mid-turn (see Design): must not move the floor; test pins it.
- First request / no user message / history starting with an assistant (resume, compaction summary as first message): floor 0 or none → echo as today, no throw.
- After compaction the history may start with a summary `user` message: floor = that index, nothing older exists → fine.
- Endpoint that 400s on the echo (D9 retry): the `echoing` flag uses the same cut, so a history with only earlier-turn reasoning no longer sends the field and no longer arms the retry.
- Persisted sessions: nothing written differently; an old log loads and is cut at send time.

### Tests

Red before green (§9), on current `8d29dd10`, then mutation (move the floor to 0 → the first test must fail again):
1. `[user, assistant{reasoning}, user, ←request]`: the wire has NO `reasoning_content` on message 2 (red today: it is sent — this is the exact shape of the 6/12 repro).
2. `[user, assistant{reasoning, toolCalls}, tool, ←request]` (same turn): `reasoning_content` IS on the assistant message (pins that the F8 win is kept).
3. Two turns, the second with a tool round: only the second turn's assistant message carries it.
4. A steer `user` message inside a turn DOES move the floor: the earlier round's
   reasoning is no longer echoed (pins the documented rule above — there is no
   marker to skip it), and the round after the steer still is.
5. `echoing` is false for a history whose only reasoning is earlier-turn → no retry path armed (fake `fetch`, existing `FakeWS`-style fake in that test file).

Live check after the fix (optional, GPU): re-run `drive.sh` ×12 through `proxy.ts` → expect 0/12 (baseline 6/12) and no stray tag in `content`.

### Owner decision (2026-11-25 ~21:45)

Owner, verbatim: «ok, per think-tag-leak vai con il turno corrente». This REPLACES reasoning-echo's Q2 A («send back always») for past turns: reasoning is echoed only for the CURRENT turn (the assistant messages after the last user message that opened it); a finished turn's reasoning stays on disk (Q1 A unchanged) but is not sent back. Update docs/fix/reasoning-echo.md's decision text with a pointer to this doc.

*— claude-opus-5-5 (orchestrator), 2026-11-25*

## Execution

*— claude-opus-4-5-20251101 (executor), 2026-11-25*

**Load-bearing check, re-run first, on real data.** `.tentacle/tmp/think-tag-leak/floor-check.ts`
applied "echo only at index ≥ the last `user` message" to the 24 captured request
bodies of the Context's repro (`calls/*.req.json`): `requests=24 echoed assistant
messages: before=12 after=0`. Every one of the 12 turn-2 requests carried exactly
one echoed assistant message — index 2, i.e. a FINISHED turn's — and the rule drops
all 12, which is precisely the `no reasoning_content on history messages` control
(6/12 → 0/12). Turn 1 (`n=2`) never echoed anything, so nothing else moves. The
check HOLDS; it is what made the cut the right lever. The within-turn arm has no
captured request (the repro never ran a tool round), so it is pinned by tests
instead (§Tests).

**Two plan fixes, both because a step contradicted the code (§8).**

1. **The floor cannot skip a steer** (Implemention, Design's open point). Verified:
   a mid-turn steer is pushed as a bare `{ role: "user", content: steer }`
   (`packages/agent/src/agent.ts:1568`), and no marker separates it from the
   message that opened the turn — not on `ChatMessage` (`packages/core/src/model.ts:33`),
   not in the log (AGENTS §7: `steer` is rendering-only, never persisted).
   `ChatRequest` carries no turn index (`packages/core/src/model.ts:286`, and it
   crosses `model/stream`, so adding one is a protocol change — out of this task's
   `contained` blast). Adopted: the floor is the last `user` message, steer
   included. Safe-directional (it can only drop echo). Plan text amended;
   `packages/agent/test/reasoning-echo.test.ts`'s D6 test retitled to the narrowed
   scope (same assertions).
2. **The cut is gated on the request offering tools.** Found by running the agent
   suite: the one request the loop builds by hand — the forced final report —
   appends a tentacle-written `user` nudge and offers no tools
   (`packages/agent/src/agent.ts:2006-2025`), so an ungated floor flipped the
   existing regression test `packages/agent/test/reasoning-echo.test.ts:147`. The
   Context's own bisect says where the leak lives: `no tools` → 0/32 hits. So
   `echoFloor(messages, tools?)` returns 0 (pre-fix bytes) when no tools are
   offered. That keeps the F8 single-turn arm byte-identical even when it hits the
   step cap, and the existing test now pins the no-tools arm unchanged.

**As built.**

- `packages/providers/src/openai-provider.ts:531` — `export function echoFloor(messages, tools?)`:
  the pure helper (index of the last `user` message; 0 when no tools are offered,
  none exists, or the history starts with an assistant).
- `:318` — the `echoing` pre-scan (D9's retry arming) counts with the SAME cut:
  `i >= floor && ownOpenAIReasoning(...)`. A history whose only reasoning is an
  earlier turn's therefore no longer sends the field and no longer arms the retry.
- `:551` + `:590,623` — `buildPayload` passes the floor into `wireMessages`, which
  hands `echoSource` to `toWireMessage` only for messages at index ≥ floor.
  `toWireMessage` itself is untouched. Cut at SEND time only: `ChatMessage.reasoning`
  stays on the message and in the log (asserted).
- `packages/providers/test/reasoning-echo-openai.test.ts` — new
  `describe("echo scope: the current segment only")` (6 tests: the helper's arms,
  the 6/12 shape, the F8 within-turn win, the steer rule, the retry-arming arm, and
  the no-tools guard) + the `history()` helper reshaped to a genuine mid-turn
  history (`[user, assistant{toolCalls, reasoning}, tool]`), because the old shape
  `[user, assistant{reasoning}, user]` was exactly the out-of-scope one. Its 11
  pre-existing assertions are unchanged.
- `docs/fix/reasoning-echo.md` — D6 and Q2 A carry the pointer to this doc (owner
  decision, above).
- `changelog.d/think-tag-leak.fixed.md` — one bullet.

**Red before green (§9).** On the helper alone (added, nothing wired) the file gave
`12 pass, 4 fail`, each on the property: `Received: "mine"` for the finished-turn and
the steer wires, `Expected: 1 / Received: 2` bodies for the unarmed-retry test.

**Mutation checks (§9 non-vacuity), each reverted after.**

| mutation | result |
|---|---|
| `echoFloor` returns 0 always (no cut) | 5 fail: the helper's arm test, the 6/12 shape, the F8 win, the steer rule, the retry arm |
| `echoFloor` returns `messages.length` (never echo) | 3 fail: `D3/D5 echoed in the same field`, the steer rule, the helper's arm test |
| the `tools` gate removed (`if (false)`) | 2 fail here (`the helper's arms`, `a no-tools request keeps the echo unchanged`) + `packages/agent/test/reasoning-echo.test.ts` `the forced final report (max_iterations) keeps its record too` — the pre-existing test, unchanged, is the third witness |

**Verified.** `bun test packages/providers` → 252 pass / 0 fail; `bun test packages/agent`
→ 1011 pass / 0 fail; `bunx biome check` on the three changed files → clean.
The full gate (`bun run check`) is the orchestrator's script's, not run here.

**Not verified — one line.** The live GPU re-run of `drive.sh` ×12 through
`proxy.ts` (expected 0/12, baseline 6/12) was not run: no llama.cpp endpoint from
this machine. Run it before merge if the endpoint is up; without it, the fix rests
on the 0/12/0/32 controls plus the captured-request check above.

**Drift from Implementation, beyond the two plan fixes:** none in the code shape;
the helper takes the extra `tools?` argument and one more test exists than the
plan listed (the no-tools guard, forced by plan fix 2).


## Review

*— claude-opus-5-5, 2026-11-25* (fresh context; Opus family, executor was Opus 4.5 → shared-family blind spots possible)

**Verdict: REQUEST-CHANGES** (one MEDIUM).

**Findings**

1. **MEDIUM — a live workflow run turns the echo OFF for the whole turn, silently.**
   `packages/agent/src/agent.ts:1667` (and `:2008`) builds every request as
   `withStatusLine(...)`, which appends a wire-only `{ role: "user" }` line at the
   TAIL after any `tool`/`user` message (`packages/agent/src/context-awareness.ts:110-117`);
   `serve` sets it whenever a workflow run is live (`packages/daemon/src/hosted-session.ts:2750`,
   `packages/agent/src/workflow-status-line.ts:71`). `echoFloor`
   (`packages/providers/src/openai-provider.ts:309-319`) then returns the LAST index,
   so no assistant round is ever ≥ floor: `reasoning_content` is dropped on every
   request of every tool loop while a workflow runs, and `echoing` is false.
   Scenario: owner's `serve` + a running workflow + DeepSeek/Qwen tool loop → the F8
   within-turn win is gone, with no test, no doc line, and contrary to the owner's
   decision («turno corrente»). The plan's Failure modes name only the steer; the same
   class also covers the loop's own mid-turn `user` notes (`agent.ts:1738, 1864, 1915,
   1927`, hook notes) — those are rarer and arguably acceptable, but they are
   undocumented too. Fix (executor's choice): either make the floor ignore a `user`
   message that directly follows a `tool` message (mid-turn by construction: a
   turn-opening prompt follows an assistant answer — this also un-penalises steers
   and notes, while still cutting every finished turn), or have the agent pass the
   status line so it is not a floor-moving `user` message; at minimum, owner-accepted
   debt in this doc + a test pinning the workflow shape.

**Gate (this review):** `bun test` of the two touched files → 25 pass / 0 fail;
`bun run lint` → clean (2536 files); `bun run typecheck` → clean. Full `bun run check`
not run (scope of the brief).

**Mutations (§9), each reverted, `git status` clean afterwards:**
| mutation | result |
|---|---|
| `echoing` scan ignores the floor | 1 fail (`only an earlier turn's reasoning arms no echo retry`) |
| wire ignores the floor (`echoSource` always) | 2 fail (F8 win, steer rule) — the 6/12-shape test survives this one alone because `echoing` is already false there; it is covered by the scan mutation |
| tools gate removed | 3 fail (helper arms, no-tools guard, agent's forced-final-report test) |
Executor's "floor = 0 always" mutation table is consistent with these.

**Premises:** `agent.ts:1568` steer push TRUE; `agent.ts:2006-2025` forced report with no tools TRUE (`:2008` also uses `withStatusLine` — see 1); `openai-provider.ts` `echoing` scan + `buildPayload` + `wireMessages` share `request.messages` and the same floor TRUE (the count-tokens `buildPayload` at `:237` gets the same cut — consistent). Nothing persisted changes (cut is in `wireMessages` only) TRUE.

**Attacks tried:** (a) index drift between `echoing` scan and wire (tool messages take the other branch of `wireMessages`) — none, `entries()` index matches; (b) §7 persistence / protocol — untouched, `ChatMessage.reasoning` stays (asserted); (c) pod path — `ProxyModelProvider` hands the same messages to the laptop provider, one cut; (d) synthetic mid-turn `user` messages — found finding 1; (e) no-tools requests (compaction/title/forced report) — floor 0 = pre-fix bytes, safe by the 0/32 control.

**Executor behaviour:** honest and disciplined — two plan fixes forced by the code were recorded with evidence, red-before-green and a mutation table given, the un-run live GPU check stated plainly. Missed the status-line path (another route to the steer shape).
