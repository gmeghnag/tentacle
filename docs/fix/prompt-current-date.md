# fix/prompt-current-date — the model is told the current date/time

> **Status:** execution
> **Branch:** `fix/prompt-current-date`
> **Size:** S · **Blast:** cross-module (the prompt: the model's copy of a message) · **Suited:** DeepSeek exec; standard Review (cross-module, not load-bearing)
> **Changelog:** `changelog.d/prompt-current-date.fixed.md`

## Context

*— deepseek-v4-pro, 2026-11-20*

The assistant wrote "2026-12-02" into MEMORY.md on 2026-11-20: nothing in the
model's prompt says what day it is. Owner decision (TODO.md, 2026-11-20) — the
**light** variant: a compact `[Fri 2026-11-20 13:42 CET]` prefix on a USER
message, added only when needed (first message of a session, the local day
changed since the last stamp, or > 30 min since the LAST STAMP — so the model's
"now" is never staler than 30 min even in a long burst). Never in the system
prompt: a per-turn change there invalidates the whole prompt cache; a prefix on
a *new* user message keeps the cached prefix intact.

Owner constraints, all binding:
- the stamp is **laptop time**, never the pod's UTC;
- the decision is a **pure, unit-tested module** (AGENTS §7);
- cron safety: a **fired** wake turn is stamped (with its fire instant, so the
  model knows when it woke up) and the stamp is added **at send time** — never
  written into the stored job prompt, or a recurring job replays an old date;
  `schedule_create` stays safe (its `at` refuses a past time, and the reason now
  shows the daemon's current time; its description prefers a relative `at`).

**Repro** (`.tentacle/tmp/prompt-current-date/repro.ts`, run 2026-11-20 on this
branch, which was fresh off `main`): a scripted provider records the exact
request of one `new Session(agent).send("what is today's date?")`:

```
--- system prompt on the wire ---
[{"role":"system","content":"You are tentacle."},{"role":"user","content":"what is today's date?"}]
date/time anywhere in the request: false
```

No date, no zone, nothing — the model cannot know the day. The `~/assistant`
note ("2026-12-02" invented on 2026-11-20) is the same defect seen from outside.

## Implementation

*— deepseek-v4-pro, 2026-11-20*

### Load-bearing assumption

The model's copy of a message is BUILT on every request from data stored on the
message, while every other reader sees the clean `content`: that is what lets
the stamp reach the model without reaching the TUI, the title generator, hooks
or steer matching, and without changing the bytes of a message an earlier
request already sent (the prompt cache). Cited:
`packages/agent/src/context-awareness.ts:61-95` (`renderForModel` /
`modelView` — the `[context: …]` line and the attached-files note are rendered
exactly this way) and its call sites in the loop
(`packages/agent/src/agent.ts:1519`, `:1847`, `:2023`); the stored-field-with-
rendering precedent is `contextUsage`
(`packages/core/src/model.ts:64-71`, `packages/protocol/src/session.ts:118-120`).

Verified against the repro above: a request's message `content` is the stored
one, so a stamp written into `content` alone would also land in the transcript.

### Preconditions

- **One send site.** Every prompt becomes a user message in `Session.send`
  (`packages/agent/src/session.ts:197-216`), reached through
  `HostedSession.prompt` (`packages/daemon/src/hosted-session.ts:2636-2745`) or
  `HostedSession.startSuccessor` for a send-now
  (`packages/daemon/src/hosted-session.ts:2873-2925`) — the one session path of
  AGENTS §7 (in-process worker, `serve`, pod alike). Compaction summaries,
  notes and steer drains are not sends and never get a stamp.
- **The daemon has a clock and the history**: `HostedSession.now`
  (`hosted-session.ts:843,918,931`) and `this.session.messages`
  (`packages/agent/src/session.ts:97`).
- **A per-client fact already travels from `initialize` to the session's
  build**: the `hop` capability, read in
  `packages/daemon/src/connection.ts:805`, carried on the attachment
  (`connection.ts:978`) and read by the host (`session-host.ts:1043-1045`). The
  zone takes the same road.
- **A fired wake goes through the same `prompt()`**
  (`hosted-session.ts:3540-3570`), so it is stamped by the same code, from the
  fire instant, without touching `job.prompt` (`schedulePromptText`,
  `packages/core/src/schedule.ts:476`).
- **Schedules never exist on a pod** (no `SessionHostOptions.schedules` there,
  `session-host.ts:151-158`), so the `schedule_create` refusal's "now" is the
  laptop host's clock.

### Design

**1. The pure module** — new `packages/core/src/current-date.ts`:

- `export interface DateStamp { readonly at: number; readonly zone: string }` —
  epoch ms + the IANA zone it is rendered in.
- `export const DATE_STAMP_MAX_AGE_MS = 30 * 60_000`.
- `export function dateStampText(s: DateStamp): string` →
  `[Fri 2026-11-20 13:42 CET]`, built from ONE `Intl.DateTimeFormat`
  (`timeZone: s.zone`, `en-GB`, `hourCycle: "h23"`) `formatToParts` → `weekday`
  short, `YYYY-MM-DD`, `HH:mm`, `timeZoneName: "short"`. Explicit parts, never
  `toLocaleString` (its comma/locale shape differs per runtime/locale).
- `export function zoneOrDefault(zone): string` — the zone only if a probe
  `Intl.DateTimeFormat` accepts it, else `Intl.DateTimeFormat().resolvedOptions().timeZone`
  (a garbage zone from a client must not break a turn).
- `export function lastDateStamp(history): DateStamp | undefined` — the last
  message carrying one (the `lastEmitted` shape, `context-awareness.ts:94-104`).
- `export function nextDateStamp(history, now, zone): DateStamp | null` — null
  means "no stamp needed": nothing stamped yet in the history (the first message
  of a session, and a resume from a log with none) → stamp; the local DAY in
  `zone` changed since the last one → stamp; `now - last.at > DATE_STAMP_MAX_AGE_MS`
  → stamp. `now <= last.at` (a clock that went backwards) and the same day →
  no stamp, never a negative age.
- `export function withDateStamp(m, text)`… not needed: the prefix is
  presentation, so it lives in the core's own `current-date.ts` as
  `dateStampPrefix(stamp): string` = `dateStampText(stamp) + "\n"`.

**2. The message carries it as data.** `ChatMessage.dateStamp?: DateStamp`
(`packages/core/src/model.ts`, next to `contextUsage`), mirrored on the wire
fail-soft (`packages/protocol/src/session.ts`: `.optional().catch(undefined)`,
the `scheduled` rule at `:159-165`) so a value outside the bounds is dropped and
the CRITICAL `message` entry still loads. NOT in `canonicalMessage`
(`packages/protocol/src/session-log.ts:569-585`) — like `note`/`scheduled`: it is
a rendering fact, and adding it would invalidate checkpoints already on disk.

**3. The model's copy gets the prefix.** `renderForModel`
(`packages/agent/src/context-awareness.ts:61`) prepends
`dateStampPrefix(m.dateStamp)` to `content` and drops the field. The bytes never
change afterwards, so the cached prefix holds; `content` stays clean for the TUI,
titles, hooks and steer matching.

**4. Who decides, with whose clock.** `HostedSession` decides, at send time,
because it has the clock and the history:

- `ClientCapabilitiesSchema.timeZone?: string` (`packages/protocol/src/session.ts:221`,
  a bounded string, never an enum: an unknown value is a zone the daemon cannot
  render and is dropped by `zoneOrDefault`, never an `InvalidParams` at
  `initialize`).
- `Attachment.timeZone?: string` (`hosted-session.ts:235-270`) — set from it in
  `connection.ts` (the `hop` road: read at `initialize` `:805`, put on every
  attachment that connection makes `:975-985`).
- The zone the session stamps with is the one its most recent client that
  DECLARED one gave (`HostedSession.clientZone`, sticky: a wake firing with
  nobody attached is still stamped in the user's zone, never the pod's UTC), else
  the daemon host's own zone. Set in `attach` (also the replay's attach path).
- `prompt()`/`startSuccessor()` compute
  `nextDateStamp(this.session.messages, this.now(), this.zone())` and pass it to
  `session.send(...)` as `opts.stamp: DateStamp`; `Session.send` stores it on the
  message it pushes (ignored when nothing is pushed, exactly like `scheduled`,
  `session.ts:206-216`).
- A fired wake passes through `prompt()`, so it is stamped from the fire instant
  (`this.now()` at the fire) — `job.prompt` is untouched, and a recurring job's
  stored text never carries a date.
- The client declares its zone in the handshake
  (`packages/client/src/remote-client.ts:3238-3250`, next to `hop`):
  `Intl.DateTimeFormat().resolvedOptions().timeZone` — the laptop's zone.

**5. `schedule_create` safety** (`packages/core/src/schedule.ts:262-268`,
`packages/tools/src/schedule.ts:80-84`): the past-`at` refusal names the current
time at the host — `at: … is in the past — it is now 2026-11-20T13:42 here; give
a future time, or use `every <interval>`` — and the tool's `at` description says
to prefer the relative form for "in N minutes/hours".

### Files

1. `packages/core/src/current-date.ts` (new) — the pure module.
2. `packages/core/src/index.ts` — export it.
3. `packages/core/src/model.ts` — `ChatMessage.dateStamp`.
4. `packages/agent/src/context-awareness.ts` — render it into the model's copy.
5. `packages/agent/src/session.ts` — `SendOptions.stamp`, stored on the push.
6. `packages/protocol/src/session.ts` — the message field (fail-soft) and
   `clientCapabilities.timeZone`.
7. `packages/daemon/src/connection.ts` — read the zone, put it on attachments.
8. `packages/daemon/src/hosted-session.ts` — `Attachment.timeZone`, the sticky
   zone, the two send sites.
9. `packages/client/src/remote-client.ts` — declare the client's zone.
10. `packages/core/src/schedule.ts` — the past-`at` reason names now.
11. `packages/tools/src/schedule.ts` — the `at` description.
12. `packages/protocol/schema/protocol.json` — regenerated by `bun run schema:export`.

No `protocol.d/` note: both wire changes are additive optional fields, which
AGENTS §7 makes free (an older daemon drops `timeZone`, an older client shows
the field's absence as no prefix).

### Failure modes

- **No zone from the client** (an older client, a pairing connection, the mobile
  app before this build): the daemon host's zone — right on a laptop `serve`,
  and never a *wrong* stamp, only a less specific one.
- **Garbage zone**: `zoneOrDefault` falls back to the host's zone; the turn runs.
- **Clock goes backwards** (`now <= last.at`): not > 30 min, day unchanged → no
  stamp; a negative age is never produced.
- **Continuation turn** (`text === ""`, a job-exit wake): nothing is pushed, so
  nothing is stamped — no message, no prefix.
- **Reload/resume**: the field rides the log through the laptop's validated round
  trip; dropped by an older build, the next message simply stamps again
  (`last === undefined` → stamp). No half-state.
- **Prompt cache**: the stamp is written once, into one message, at its creation;
  every later request re-renders identical bytes, and a message without the field
  renders as before.
- **Cron**: the stamp lives only on the pushed user message; `job.prompt` and
  `schedulePromptText(job)` are untouched, so a recurring job cannot replay an
  old date.
- **A fire with no attached client**: stamped from the fire instant in the
  remembered zone (sticky `clientZone`), never skipped.

### Tests

Red before green (§9), each naming its mutation.

- `packages/core/test/current-date.test.ts` (new, fake clock): the first message
  stamped; a same-day burst within 30 min not re-stamped; > 30 min since the
  LAST STAMP re-stamped even though the last message was a minute ago; a midnight
  crossing stamped (the local day in the zone, not UTC); a resume whose history
  carries a fresh stamp not re-stamped, one with none stamped; the exact
  text/zone rendering for `Europe/Rome`, `America/New_York`, `UTC`; an invalid
  zone falls back instead of throwing.
- `packages/agent/test/date-stamp.test.ts` (new): the model's request carries
  `[Fri 2026-11-20 13:42 CET]\n…` while `session.messages[i].content` stays
  clean; two requests over the same message render identical bytes (the cache);
  a message without `dateStamp` renders unchanged.
- `packages/daemon/test/date-stamp.test.ts` (new, injected clock + scripted
  model, the `schedules.test.ts` rig): the first prompt is stamped; a fired job
  is stamped with its FIRE instant while the stored job prompt is untouched
  (`scheduleLink().list()[0].prompt` has no stamp) and the second fire of the
  SAME recurring job carries a different time; a client that declared
  `clientCapabilities.timeZone` gets that zone even though the daemon's own is
  another one.
- `packages/core/test/schedule.test.ts` (extend): a past `at` is refused with the
  daemon's current time in the reason.

## Execution

*— deepseek-v4-pro, 2026-11-20*

As-built, in the Implementation's order (all committed to the worktree, not git):

1. `packages/core/src/current-date.ts` (new): `DateStamp`, `DATE_STAMP_MAX_AGE_MS`,
   `zoneOrDefault`, `dateStampText`, `dateStampPrefix`, `lastDateStamp`,
   `nextDateStamp`. Exported from `core/src/index.ts`; `ChatMessage.dateStamp`
   added in `core/src/model.ts`.
2. `packages/agent/src/context-awareness.ts`: `renderForModel` prepends the
   prefix (first), appends the context line (last) and drops the field.
3. `packages/agent/src/session.ts`: `SendOptions.stamp` → stored as `dateStamp`
   on the pushed message.
4. `packages/protocol/src/session.ts`: `dateStamp` fail-soft on the message,
   `clientCapabilities.timeZone`; `schema:export` regenerated
   `packages/protocol/schema/protocol.json` (+53 lines, additive only).
5. `packages/daemon/src/connection.ts` (zone read at `initialize`, carried on
   every attachment) and `hosted-session.ts` (`Attachment.timeZone`, the sticky
   `clientZone`, `attach` remembering it, `stampFor`, the two send sites).
6. `packages/client/src/remote-client.ts`: the handshake declares the laptop's zone.
7. `packages/core/src/schedule.ts` + `packages/tools/src/schedule.ts`: the
   past-`at` reason names the host's current minute; the `at` description
   prefers the relative form.

**Drift from Implementation (2 items):**

- **A fired wake is stamped from its fire instant ALWAYS, not by
  `nextDateStamp`.** `HostedSession.stampFor(schedule)` returns
  `{at: schedule.at, …}` when a wake fires: a 10-minute recurrence would
  otherwise fall inside the 30-minute window and the model would read a stale
  clock at the very moment it woke up. That is what the owner's "the model must
  know when it woke up" asks for; the doc's Design read it as "the same rule
  from the fire instant" and is now corrected here rather than in the tests.
- **The prefix changes the model's copy of a FIRST user message everywhere**,
  by construction (that is the feature). Existing daemon test files that
  dispatch on, or assert the equality of, that exact text need the stamp
  tolerated: `schedules.test.ts`, `parallel-agents.test.ts`, `queued.test.ts`,
  `send-now.test.ts`, `integration.test.ts`, `attachment-prompt.test.ts`,
  `prompt-documents.test.ts`, `serve-log-store.test.ts`, `persistence.test.ts`.
  This was NOT in the Implementation's *Files* list — an under-estimate of the
  blast radius, recorded here. `packages/{agent,core,protocol,tools}/test` are
  green untouched (2436 pass).

**Tests (red before green, each mutation pasted):**

- `packages/core/test/current-date.test.ts` (17 tests) — new.
- `packages/agent/test/date-stamp.test.ts` (8 tests) — new.
- `packages/daemon/test/date-stamp.test.ts` (7 tests) — new.
- `packages/core/test/schedule.test.ts` — one added test (the past-`at` reason).

**Mutations run (all red, then reverted — `git diff` clean of each):**

| mutation | result |
| --- | --- |
| drop the prefix in `renderForModel` | agent/date-stamp: 5 of 8 fail |
| stamp on EVERY message (`nextDateStamp`) | core+daemon: 6 fail |
| the daemon drops the client zone | daemon/date-stamp: 5 of 7 fail |
| a fired wake uses the ordinary rule | daemon/date-stamp: 2 fail |
| the past-`at` reason drops the current time | core/schedule: 1 fail (the new test) |
| `stampOption` returns `{}` always | daemon/date-stamp: 6 of 7 fail |

### Execution — resume

*— claude-opus-5-5, 2026-11-21*

DeepSeek was stopped by the watchdog with its production edits complete but
the existing suites only partly adapted: the list above names
`integration`, `attachment-prompt`, `prompt-documents`, `serve-log-store` and
`persistence`, none of which had been edited, and the blast also reaches
`client`/`cli` tests that drive a real daemon. Kept every production edit
as-is (no production code changed on resume); adapted the tests only.

Running the affected files found 11 daemon + 22 client/cli failures (tui: 0 of
2877). Two kinds, each handled one way:

- **A test pins the model's bytes or the stored message** → the stamp is
  ASSERTED present (`stampLine(...)` defined, or `dateStamp: {at: any Number,
  zone: any String}` on the stored message), then the rest compared exactly:
  `daemon/{attachment-prompt,prompt-documents,persistence,serve-log-store,send-now U2}`,
  `client/remote-session-attach`, `cli/model-proxy`.
- **A scripted model dispatches on / echoes the prompt text, or a test compares
  the history the model saw** (not the subject) → `stripped(...)`:
  `daemon/integration` (2 models), `client/{send-now,queued-broadcast,remote,foreign-turns}`,
  `cli/{clear-resume,local-runtime,connect,session-hop,session-hop-e2e}`,
  `tui/clear-resume`.

The helper stays in `packages/daemon/test/support/model-prompt.ts`, imported
cross-package by relative path (precedent: `client/test` already imports
`../../daemon/test/support/daemon-store-spy.ts`). `serve-log-store` (b) was a
cascade of (a) (a failed assert left the shared `PARKED` gate closed), not a
separate defect.

Observed, not changed (Implementation behaviour): an image-only prompt sends
the model `"[… UTC]\n"` (the stamp plus an empty text); harmless.

**Mutation (resume):** `stampOption` → always `{}` ⇒ all 11 byte/record-pinning
assertions above go red (`attachment-prompt` 3, `prompt-documents` 1,
`persistence` 1, `serve-log-store` 2, `remote-session-attach` 1, `model-proxy`
3); reverted, green.

**Ran (resume):** `packages/daemon/test` + `packages/client/test` (2365 pass,
1 opt-in skip), `packages/cli/test` (re-run of the 9 fixed: green; rest 2726
pass, 2 opt-in skips), `packages/tui/test` (2877 pass), core/agent new tests,
`protocol/test/json-schema` (no drift). `biome check` on the 38 changed files:
clean. Full gate (typecheck, full suite, lint) left to the orchestrator.

### Fix round 1

*— claude-opus-5-5, 2026-11-21* (executor of round 1; same model as the reviewer — see the honesty note at the end)

Review finding 1 (MEDIUM) fixed. Two independent layers, because the bad value
has two independent ways in:

**Reproduced first** (`.tentacle/tmp/prompt-current-date/big.ts`, current code
before any edit): `ChatMessageSchema.safeParse({… dateStamp: {at:
8_640_000_000_000_001}})` → `true`; then `dateStampText`, `nextDateStamp` and
`renderForModel` each `RangeError: date value is not finite in
DateTimeFormat formatToParts()`. Also measured the boundary in the runtime:
`formatToParts` accepts `±8_640_000_000_000_000` and throws one past it, so the
bound is the JS Date range exactly (inclusive).

**1. Schema bound — `packages/protocol/src/session.ts:130-144.** `dateStamp.at`
gained `.max(8_640_000_000_000_000)`, which is what makes the field's existing
`.catch(undefined)` actually fire for this class of value: the stamp is dropped,
the message still loads unchanged, the next message simply stamps again. The
doc comment now says why the upper bound is load-bearing. `bun run
schema:export` regenerated `packages/protocol/schema/protocol.json` (+3 lines,
`"maximum": 8640000000000000` in the three places the message shape appears);
`protocol/test/json-schema.test.ts` passes, no drift.

**2. Render-time guard — `packages/core/src/current-date.ts:32, 60-124, 138-171.**
A `ChatMessage` can also be built in memory or arrive from a path that never
parsed, so the renderer no longer trusts the bound either: new
`DATE_STAMP_MAX_AT_MS` + a private `renderable(at)` (finite **and** `|at| <=
MAX`), `partsOf` returns `null` for an unrenderable instant, `dateStampText`
returns `""`, `dateStampPrefix` returns `""` (no prefix **and no stray
newline**), `nextDateStamp` treats a `now` it cannot render as "stamp nothing"
(`null`) and an unrenderable last stamp as "no stamp at all" (so the session
re-stamps from `now` instead of throwing). `renderForModel`
(`packages/agent/src/context-awareness.ts:77`) is unchanged: it now gets `""`
and the message renders exactly as if it had no stamp. Negative beyond the range
is guarded too, though the schema's `.nonnegative()` already refuses it.

**Tests (red shown first, on the buggy code).**
- `packages/protocol/test/session.test.ts` — new describe
  `ChatMessage.dateStamp`: an out-of-range / `NaN` / `Infinity` / negative `at`
  is DROPPED and the message loads as `{role, content}`; the two inclusive
  boundaries (`8_640_000_000_000_000`, `0`) are KEPT. **RED before:**
  `expect(stamp(DATE_MAX + 1)).toBeUndefined()` → `Received: {at:
  8640000000000001, zone: "UTC"}` (1 fail, 22 pass).
- `packages/core/test/current-date-bounds.test.ts` (new) — `dateStampText` /
  `dateStampPrefix` yield `""` for an unrenderable `at`; a history whose last
  stamp is unrenderable is stamped again from `now`; an unrenderable `now`
  stamps nothing. **RED before:** all 3 fail — `RangeError` from `partsOf` on the
  first two, `Received: {at: 8640000000000001…}` (should be `null`) on the third.
  (The module import had to exist first — `DATE_STAMP_MAX_AT_MS` was added as a
  constant in the same commit as the guard — so the red is on the assertion, not
  an import error; §9.)
- `packages/agent/test/date-stamp.test.ts` — a stamped message with an
  unrenderable `at` renders as plain `"ciao"` with the field dropped. **RED
  before:** `RangeError` from `formatToParts` through `renderForModel`.

**Mutation checks (each reverted; `diff` against the saved copy confirmed clean).**
- Drop `if (!renderable(at)) return null;` from `partsOf` → 4 fail
  (`current-date-bounds` 3 + `agent/date-stamp` 1, all on `RangeError`).
- Drop `.max(8_640_000_000_000_000)` from `session.ts` → `session.test.ts` 1
  fail: `Received: {at: 8640000000000001, zone: "UTC"}`.
- Off-by-one `.max(8_639_999_999_999_999)` → 1 fail: the inclusive-boundary test.
- `nextDateStamp`: `if (last === undefined)` only (no `lastParts === null`
  clause) → 1 fail, `TypeError: null is not an object (evaluating
  'lastParts.date')`.
- `nextDateStamp`: substitute empty parts for a null `now` → 1 fail, the
  "`now` outside the range stamps nothing" test.

**Ran:** `packages/core/test` (716 pass), `packages/agent/test` (723 pass),
`packages/protocol/test` (569 pass with `daemon/date-stamp` +
`core/schedule`), `daemon/date-stamp.test.ts`. `bunx biome check` on the 5
changed files after `--write`: clean. Full gate (typecheck, full suite, lint)
left to the orchestrator per the brief.

**Honesty note:** the reviewer of round 0 and this executor are the same model
(`claude-opus-5-5`); the fix is deliberately built so review does not have to
trust that — the red output, the four mutations and the boundary measurement are
all in the commands above and reproduce on their own.

### Fix round 2 — the gate's typecheck failure

*— deepseek-v4, 2026-11-21*

The orchestrator's gate failed on one line of round 1's new test:
`current-date-bounds.test.ts(31,24): TS2353 … 'role' does not exist in type
'{ readonly dateStamp?: DateStamp }'`. Not a code defect — an excess-property
check on a direct object literal passed to the structural parameter.

Fixed exactly that, in the test only (`packages/core/test/current-date-bounds.test.ts`):
the literal is hoisted into a local `Entry` type (the same
`{ role; dateStamp? }` shape `current-date.test.ts:22` uses for the same
reason) instead of being written inline in the call. No production code touched.

**Ran:** `bunx tsc --noEmit` (whole repo) → clean; `core/current-date`,
`core/current-date-bounds`, `agent/date-stamp`, `daemon/date-stamp` → 36 pass,
0 fail; `bunx biome check` on the file → clean.

## Review

*— claude-opus-5-5, 2026-11-21* (fresh context; same model as the Execution-resume pass, different model from the DeepSeek executor)

**Verdict: REQUEST-CHANGES** (1 MEDIUM).

**Gate (touched scope):** 12 touched test files + `packages/protocol/test`: 873 pass / 0 fail. `bun run lint`: clean (2169 files). `bun run typecheck`: clean. Full `bun test` not re-run here (orchestrator's merge gate).

**Findings**

1. **MEDIUM — an unrenderable `dateStamp.at` passes the schema and poisons the session.**
   `packages/protocol/src/session.ts:132` bounds `at` only as `int().nonnegative()`; any value > 8.64e15 (JS Date max) is kept, and `partsOf` (`packages/core/src/current-date.ts:72`) throws `RangeError: date value is not finite`. Thrown from BOTH `nextDateStamp` (`current-date.ts:125`, every `prompt()`) and `renderForModel` (`packages/agent/src/context-awareness.ts:77`, every model request) — so one such entry makes every later turn of that session fail, permanently. The fail-soft `.catch(undefined)` the doc relies on never fires because the value is schema-valid. Source: pod-supplied history (AGENTS §7 "a pod is not trusted": a pod's `session/log` entries are validated and persisted on the laptop, then fed back via `--resume`/`open{messages}`), or a corrupted log line. Repro (`.tentacle/tmp/prompt-current-date/big.ts`): `at = 8.64e15+1` → schema keeps it; `dateStampText` and `nextDateStamp` both throw. Fix: `.max(8_640_000_000_000_000)` on `at` (so `.catch` drops it) and/or make `partsOf` fail-soft; add the boundary test.

**Premises:** the load-bearing one holds — the stamp is data on the message, rendered only into the model's copy (`context-awareness.ts:61-80`), `content` stays clean, bytes stable across requests (agent test pins it). Both send sites (`prompt`, `startSuccessor`) stamp; a fired wake uses its fire instant and `job.prompt` is untouched (daemon test). Zone travels `initialize` → `Connection.timeZone` → `Attachment.timeZone` → sticky `clientZone`.

**Attacks tried**
- Out-of-range `at` (above): FOUND finding 1.
- Mutation: drop the day-change clause in `nextDateStamp` → `current-date.test.ts` 2 fail (midnight in zone, clock-backwards); reverted, `git status` clean.
- Prompt cache: stamp prepended only to the new user message; earlier messages re-render byte-identical — holds.
- Cron replay: stored recurring prompt never stamped; second fire carries a new time — holds (daemon test).
- Garbage / absent client zone → `zoneOrDefault` host fallback, no `InvalidParams` — holds.
- Protocol: both wire fields additive optional; no `protocol.d/` note needed (AGENTS §7 forward-compat) — holds.

**Notes (not blocking):** `daemon/date-stamp.test.ts:187` ("client zone beats host zone") is vacuous on a host whose zone is `America/New_York`; steer-drained messages in a long turn are never stamped (out of the owner's scope).

**Executor behaviour:** DeepSeek's production edits were coherent and well-commented; it under-estimated the test blast radius (recorded honestly in Execution) and was stopped mid-adaptation; the resume adapted tests only. The missed upper bound is the classic "fail-soft on paper, not in fact" gap.

### Round 2

*— claude-opus-5-5, 2026-11-21*

**Verdict: APPROVE.** Finding 1 is fixed. Reviewed `2eb150cf` (the fix) and `68c80050` (test typing only).

- **Schema:** `packages/protocol/src/session.ts:139` now caps `at` at `.max(8_640_000_000_000_000)`, so `.catch(undefined)` drops an out-of-range stamp and the message still loads. `protocol.json` was regenerated with the same cap.
- **Renderer:** `renderable()` guards `partsOf` (`packages/core/src/current-date.ts`). An unrenderable stamp renders as no prefix. When the last stamp is unrenderable, `nextDateStamp` stamps again from `now`. When `now` itself is out of range, it stamps nothing.
- **Mutations:** (M1) dropping the schema `.max` → `protocol/session.test.ts` 1 fail. (M2) disabling the `renderable` guard → 5 fail across core bounds, agent and protocol. Both reverted; `git status` clean.
- **Round-1 repro** (`big.ts`): `at = 1e17` is dropped by the schema, and `dateStampText` / `nextDateStamp` no longer throw.
- **Gate:** protocol + core + agent + daemon date-stamp tests: 558 pass / 0 fail. `bun run lint`: clean. `bun run typecheck`: clean.
- **Regressions:** none found. The boundary value `8.64e15` is still accepted and renders (tested inclusive). Negative `at` is still refused by the schema; the renderer accepts down to −max, which is harmless.
