# fix/thought-placeholder — A reopened session keeps its Thought rows (as a placeholder)

> **Status:** execution done — awaiting fresh-context Review (mandatory: load-bearing)
> **Branch:** `fix/thought-placeholder`
> **Type:** fix · **Size:** S–M · **Blast:** load-bearing (persisted message field) · **Suited:** Opus exec + fresh Opus review
> **Changelog:** `changelog.d/thought-placeholder.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-18*

Re-entering a session on the phone, every **Thought** row of its turns is gone
(simulator QA, `docs/fix/mobile-qa-1117.md` bug 2 and `docs/fix/mobile-qa-1118.md`
row 3, shots `.tentacle/tmp/mobile-qa-1118/shots/03-reopen-toolrows-{light,dark}.png`
vs the live `flow-29-tool-rows-collapsed-*`). Both tasks PARKED it: the reasoning
text is not in `ChatMessage` (`packages/core/src/model.ts:32`), it reaches a phone
only live (`agent_thought_chunk`, `packages/daemon/src/mapping.ts:264`), so
`historyRows` (`apps/mobile/src/transcript-history.ts`) has nothing to project.

**Owner decisions (binding):**

- *2026-11-18 ~16:15 — option 3:* persist only a **placeholder**, never the
  reasoning text: after a reopen a Thought row reads `Thought · 12 s`, collapsed,
  nothing to expand (and its a11y label says so). Same shape as `scheduled`
  (`docs/feat/scheduled-fire-row.md`): an optional FAIL-SOFT display-only field on
  the assistant `ChatMessage`, set agent-side, `.catch(undefined)` on read, never
  sent to the model. Old logs: no Thought rows (as today).
- *2026-11-18 ~16:50 — decision 2, TUI option B:* **no** Thought row on the Mac
  TUI, live or on resume (it keeps its live "Thinking…" indicator). On the phone:
  a reasoning followed by a **tool** stays folded into that step (with the
  "thought first" hint); a reasoning followed by **text** is its own collapsed,
  non-expandable `Thought · N s` row — **live and after a reload alike**. Every
  TUI-parity requirement is dropped.

**Repro** (2026-11-18, `fix/thought-placeholder` = `main` 3781bfda, before any
source edit): `apps/mobile/test/thought-placeholder.test.ts` (kept as the
regression test) loads a stored thinking turn through `historyRows` and folds a
live one through `apply`, then asserts the Thought row:

```
(fail) reload: … > thought → text: one collapsed `Thought · 12 s` row before the answer
(fail) reload: … > thought → tool: folded into the step, which says `thought first`
(fail) live: … > reasoning then text: `Thought · 12 s`, measured from the receipt times
(fail) live: … > reasoning then a tool: folded into the step with its text (live body)
 1 pass   (the guard: an old log without the field draws no Thought row)
 4 fail
```

(The first fails on `["user","assistant"]` ≠ `["user","reasoning","assistant"]`:
the reload projects no reasoning row at all.)

## Implementation

*— claude-opus-5-5, 2026-11-18*

### Load-bearing assumption

**Every provider request maps `ChatMessage` field by field, so a new field on a
stored message never reaches the model.** Verified: `buildPayload`
(`packages/providers/src/anthropic-provider.ts:492-512`) builds `{ role, content }`
/ content blocks; `OpenAIProvider` builds `{ role: message.role, … }`
(`openai-provider.ts:424`); the precedent tests for `compacted`/`scheduled`
(`packages/providers/test/compaction-fact.test.ts`). Proven for `thought` by two new
byte-identity tests, red under a `...message` mutation of either mapper.

### Preconditions

- `ChatMessageSchema` is a strip schema shared by the wire snapshot and the
  CRITICAL `message` log entry (`packages/protocol/src/session.ts:96,185`); a FAIL-SOFT
  field (`.optional().catch(undefined)`) drops a malformed value without refusing
  the entry — the `scheduled` pattern (`session.ts:165`). Additive on a strip
  schema, display class → **no `PROTOCOL_VERSION` bump, no `protocol.d/` note**
  (AGENTS §7 "fields are free"); an older reader strips it (tested).
- On-disk: no new entry type, no header/sidecar change → no `schemaVersion` /
  `DAEMON_STATE_VERSION` change. The field rides the existing `message` entry.
- The agent loop already times tool runs on an injectable monotonic clock
  (`this.config.now ?? performance.now`, `packages/agent/src/agent.ts` `timed`).
- The phone's live fold receives a receipt time per event
  (`apps/mobile/src/session-feed.ts:259`, `apply(state, event, now())`).
- Live, consecutive reasoning deltas merge into ONE row (`transcript.ts`
  `lastTextRow`), and `stepLayout` joins a run of reasoning rows into ONE node
  (`tool-steps.ts` `flushOrphan`/fold) ⇒ **one placeholder per assistant
  message** is what the live rows need. So the shape is `thought?: { ms }`; the
  suggested count `n` is not stored (nothing would read it).

### Design

1. **Core** — `ChatMessage.thought?: ThoughtFact` (`{ ms }`), doc'd display-only
   (`packages/core/src/model.ts:110-123`).
2. **Protocol** — `thought: z.object({ ms: int ≥ 0 ≤ 24 h }).optional().catch(undefined)`
   (`session.ts:166-177`); `protocol.json` regenerated (`bun run schema:export`).
3. **Agent** — `ThinkingClock` (`packages/agent/src/thinking-clock.ts`, pure): a
   run starts at a reasoning delta that is not whitespace and ends at the next
   non-reasoning stream event (text, tool call, `done`); runs are summed. Every
   assistant message a round pushes spreads `...thinking.fact()` (normal round,
   the kept-text error paths, the `max_iterations` final report:
   `agent.ts:1532-1536, 1594, 1619, 1656-1657, 1863-1896`). No text is kept.
4. **Phone, reload** — `historyRows` pushes `{ kind: "reasoning", text: "", ms }`
   before the message's text/tool rows (`transcript-history.ts:144-151`).
5. **Phone, live** — a reasoning row takes its first delta's receipt `at`; the
   next input that is not reasoning/link closes it with `ms = now − at`
   (`transcript.ts:231, 295-313`): the same edges the agent measures between.
6. **Phone, layout** (`tool-steps.ts`) — an orphan node is made for a run with
   text OR a stored placeholder, and carries `ms` (summed), not text; a step gets
   `thoughtFirst` from text OR placeholder, which feeds `stepA11yLabel`'s
   "thought first". `thoughtRowView({ ms })` → `· 12 s` / `· <1 s` / `· 2 min 5 s`,
   `expandable: false`, a11y `Thought for 12 seconds. The thinking itself is not kept.`
7. **Phone, render** (`TranscriptRow.tsx` `ReasoningRowView`) — `Thought` + the
   duration, the ∴ node unchanged (same glyph/position live and reloaded), no
   `onToggle`, no body. `ToolRowView` passes `cell.thoughtFirst`.
8. **TUI** — nothing (decision 2). A guard test pins that `messagesToItems` is
   identical with and without the field.

### Failure modes

| Case | Converges to |
|---|---|
| Old log / older daemon (no field) | no Thought row, as before (test) |
| Malformed `thought` on disk or wire | dropped by `.catch`, message loads, no Thought row (test, ×7 shapes) |
| Newer build adds e.g. `thought.text` | stripped by the strip schema, never kept (test) |
| Older reader | strips the whole field (test) |
| Whitespace-only reasoning | no field (agent) and no row (phone) — same rule both sides (test) |
| Reasoning to the stream's end, no text | closed at `done` (test); a round with no text/tools is popped anyway |
| Two thinking runs in one round | summed into one placeholder (test); see debt below |
| Live row with no clock (unit fold) / turn ends mid-thought | no `ms` → `Thought` alone, never a guessed time (test) |
| Thought → parallel batch | only the first step of the batch is `thoughtFirst` (existing `batchOpen` rule) |
| Model sees it | never: byte-identical request bodies, both providers (tests) |

### Tests

- `apps/mobile/test/thought-placeholder.test.ts` — the repro (RED on main → GREEN).
- `packages/agent/test/thinking-placeholder.test.ts` — measurement on a fake clock.
- `packages/protocol/test/thought-placeholder.test.ts` — fail-soft / strip / log entry.
- `packages/providers/test/compaction-fact.test.ts` (+2) — never reaches the model.
- `packages/daemon/test/persistence.test.ts` (+1) — survives a daemon restart into the snapshot.
- `packages/tui/test/resume.test.ts` (+1) — TUI unchanged (guard).
- Updated: `tool-steps`, `tool-step-view`, `step-thought-marker`, `tool-rows-wiring`
  (the orphan row no longer carries text and is not expandable).

## Execution

*— claude-opus-5-5, 2026-11-18*

Done in plan order: core → protocol (+ `schema:export`) → agent → phone → tests.

**Red → green.** The repro above (4 fail / 1 guard pass on the untouched tree) →
5/5 pass after the phone slice.

**Mutation (non-vacuity, §9)**, each applied alone, the named test file run, then
reverted (script `.tentacle/tmp/thought-placeholder/mutate.py`):

```
anthropic spreads message:        exit=1  3 fail   (compaction-fact.test.ts)
openai spreads message:           exit=1  2 fail
protocol no catch:                exit=1  2 fail   (protocol/thought-placeholder)
agent no fact:                    exit=1  2 fail   (agent/thinking-placeholder)
history no placeholder:           exit=1  2 fail   (mobile/thought-placeholder)
live no close:                    exit=1  1 fail
no thoughtFirst from placeholder: exit=1  1 fail
```

**Drift from the owner's brief:** `n` (block count) is not stored — live rows
merge a round's reasoning into one node, so one summed `ms` per message is what
the projection needs (Preconditions). TUI frames: not produced — decision 2
dropped the TUI parity they were for; a `messagesToItems` guard test stands in.

**Simulator** (iPhone 17 Pro Max 0B43D716-…, iOS 26, Release build of this branch):
`bun apps/mobile/e2e/run.ts --ios 26 --udid 0B43D716-… --only 29-tool-rows --hold`
→ `✓ 29-tool-rows`, serve on 127.0.0.1:60939 (ephemeral, not 4000). Then
drawer → Alpha → drawer → compose (Maestro, `.tentacle/tmp/thought-placeholder/flows/reopen.yaml`).
Shots in `.tentacle/tmp/thought-placeholder/shots/`:
- `before-reopen-main-light.png` — main's reopen (copied from the
  `mobile-qa-1118` QA, `main @ b39119de`; the projection is unchanged on
  `main` 3781bfda): no Thought rows. Not re-shot on a fresh main build.
- `live-light.png` — live: `∴ Thought · <1 s` before "Checking the workspace
  first.", the round-2 thought folded into `Read notes.txt` (no row), and
  `∴ Thought · 10 s` before the answer.
- `after-reopen-light.png` — after the reopen: **the same two rows, same glyph,
  position and text** as live. (Durations: round 1 thinks for a few ms in the
  mock, round 3 for 4 × 2.5 s spacing.)
Dark mode not shot after the reopen (the row reuses the existing ∴ node and colours).

**Gate** (2026-11-18): `bunx tsc --noEmit` ✓ · `bunx tsc -p apps/mobile --noEmit` ✓
· `bunx tsc -p apps/relay --noEmit` ✓ · `bun run lint` → `Checked 2095 files … No
fixes applied` (0 errors/warnings, after `biome check --write` on two files' import
order/format) · `bun test` → `15426 pass, 5 skip, 0 fail` (1097 files, 610 s). The
5 skips are opt-in env-gated suites; none is in a file this task touched.

**Debt / unverified:**
- A round that thinks, writes text, then thinks again before a tool shows live as
  `Thought · a s`, text, step(thought); a reload shows `Thought · (a+b) s`, text,
  step (no hint). Rare (interleaved thinking inside ONE round); accepted rather
  than storing per-run positions.
- Live `ms` is measured on the phone's receipt clock, the stored one on the
  agent's; they share edges but can differ by network jitter (a second at most
  at a boundary).

## Review

*— claude-opus-5-5, 2026-11-18* (fresh context; same model as the executor — shared blind spots possible)

**Verdict: REQUEST-CHANGES** (1 MEDIUM).

1. **MEDIUM — live whitespace-only reasoning draws a `Thought · N s` row that a reload never shows.**
   `apps/mobile/src/transcript.ts:469` stamps `at` on a reasoning row even when its delta is
   whitespace; `closeThought` (`transcript.ts:300-311`) then sets `ms`; `placeheld`
   (`apps/mobile/src/tool-steps.ts:73-75`) counts ANY row with `ms`, so `flushOrphan`
   (`tool-steps.ts:148`) makes an orphan node though `joined()` is null. The agent stores no
   field for that round (`thinking-clock.ts:25`). Repro (`.tentacle/tmp/thought-placeholder/ws.ts`):
   `reasoning "  \n"` @1100 → `text "hello"` @5000 ⇒ cell `{kind:"thought", ms:3900}` live; reload:
   no row. The Failure-modes row "Whitespace-only … no row (phone) — same rule both sides (test)"
   is FALSE on the phone side: no phone test covers it (`tool-steps.test.ts:71` has no `ms`).
   Fix: a placeholder is a row with `text === ""` and `ms` (or stamp `at` only at the first
   non-blank delta, which also aligns the start edge with the agent), plus a live red→green test.

**Gate:** `bun run lint` clean (2095 files); `bun run typecheck` ✓; touched files 244 pass / 1 fail —
the fail is `step-thought-marker.test.ts` run ALONE (`Export named 'EventEmitter' not found`,
expo-modules-core): it lacks the `expo-file-system` mock that `notice-row.test.ts:103` has, an
isolation gap since `b7b6de2b` (model-diagrams), not this diff (no import changes in
`apps/mobile/src`); passes inside the full suite. Worth a one-line mock add, not a finding.

**Mutations (reverted, tree clean):** drop the agent whitespace guard → 1 fail; drop `ms` in
`historyRows` → 2 fail.

**Attacks tried:** (a) other provider mappers spreading `ChatMessage` — only anthropic/openai exist,
both field-by-field: holds. (b) `usage` arriving mid-reasoning and freezing the live clock — the
agent yields `usage` only at `done` (`agent.ts:1548-1556`): holds. (c) fields copied by
whitelist elsewhere (`scheduled` sites: `tui/resume.ts:120`, `hosted-session.ts:2693`) — none
needed for `thought` (TUI decision 2): holds. (d) protocol: strip + `.catch`, no version bump
needed (display, additive): holds. (e) whitespace live path: finding 1.

**Executor behaviour:** thorough plan, honest debt notes; one failure-mode row claimed tested
on both sides when only the agent side was.

### Fix round 1

*— claude-sonnet-4-5, 2026-11-18*

Round 1 = Review's 1 MEDIUM (no HIGH was raised). Two changes, one source, one test:

1. **Live whitespace-only reasoning draws no row at all** (`apps/mobile/src/transcript.ts:464-469`):
   in `applyAgentEvent`'s `reasoning` case, a delta whose `trim()` is empty and that
   would OPEN a row (no reasoning row to extend) returns the state unchanged. The
   fold keeps no row whose `text` says nothing, so `placeheld` (`tool-steps.ts:73`)
   can no longer manufacture a `Thought · N s` cell that a reload never shows —
   and the phone's rule is now the agent's (`thinking-clock.ts` stores no fact for
   a blank run). Blank deltas arriving AFTER a row exists still extend it (test).
   The alternative in the finding — "a placeholder is a row with `text === ""` AND
   `ms`" — was rejected: it fixes the cell but leaves a phantom reasoning row in
   the fold that no other path creates (the reload projects none), i.e. it treats
   the symptom. Dropping the row makes live and reload agree on the ROWS, and with
   it the second half of the finding (start edge = first non-blank delta) falls out
   for free: the run's `at` is now necessarily its first non-blank delta's receipt.
2. **`apps/mobile/test/step-thought-marker.test.ts` gets the `expo-file-system`
   stub** (`:67-72`, the line `notice-row.test.ts` carries): the Review's
   not-a-finding isolation gap, closed while the file was open — it failed ALONE
   (`Export named 'EventEmitter' not found`) and passed only by mock leakage from
   an earlier file in the full run.

**Red → green** (`apps/mobile/test/thought-placeholder.test.ts`, +2 tests, the
whitespace repro the finding names):
- `red` before the edit: `expect(received).toHaveLength(expected)` — `Expected
  length: 0 / Received length: 1` (`:100`) ⇒ live drew a `Thought` cell for
  `"  \n"` @1000 → `text` @5000.
- `green` after: 8 pass / 0 fail in that file (was 5 pass).

**Mutation (§9, each alone, revert verified by `git diff --stat`):**
```
guard disabled (`if (false && event.delta.trim()`):  2 fail  (the new tests, thought-placeholder)
```
A second mutation was tried for the timing half (`const starts = false;` in a
first-draft "restamp `at` at the first non-blank delta" block) and it **did not
fail** — that block was dead code, since a row is now only ever created by a
non-blank delta. It was removed rather than kept as an untested branch; the
timing test (`· 4 s`, blank @1000 → `let me think` @5000 → `text` @9000) is green
on the shipped code, and it is what the guard protects: with the guard disabled
the row starts at 1000 ⇒ `· 8 s` (the pre-fix reading).

**Gate (this round, run by the orchestrator):** not run here beyond the narrow
scope — `biome check` on the 3 touched files clean; `bunx tsc -p
apps/mobile --noEmit` ✓; `bun test apps/mobile/test` → 3688 pass / 0 fail (252
files, 16.6 s), which also shows the `step-thought-marker` stub holds in-file.
