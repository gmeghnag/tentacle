# feat/scheduled-fire-row — A fired scheduled wake is a timeline event, not a user bubble

> **Status:** implementation (awaiting owner approval)
> **Branch:** `feat/scheduled-fire-row`
> **Size:** S–M · **Blast:** cross-module (core parser + TUI row + mobile row; no protocol, no persistence change) · **Suited:** Opus plan + DeepSeek exec, standard in-context Review
> **Changelog:** `changelog.d/scheduled-fire-row.changed.md`

## Context

*— claude-opus-5-5, 2026-11-17*

A fired scheduled wake (`docs/feat/cron-tool.md`) shows in the chat as a **user
bubble** that holds the model-facing prefix verbatim:
`[scheduled sc-1 · at 2026-11-17T15:54 · fire 1] Il cron di 10 minuti fa: …`,
with a raw ISO time, under a cyan `◷ Scheduled · at 2026-11-17T15:54` head (owner's
phone screenshot, 2026-11-17, `.tentacle/tmp/scheduled-fire-owner-shot.png`).
Owner: *"si deve vedere sempre come parte della timeline e meno sporco"*.
So the row must be:

- a **timeline event** (not something the person typed);
- **clean**: no `[scheduled …]` bracket, no raw ISO;
- **identical live, after a reload, and on the Mac TUI**. Today a reload loses
  even the head, because the head hangs on the display-only `turn_start.schedule`
  ref, which is never stored (`cron-tool.md` M4/M8 "B degrades to A on reload").

Mockups were picked by the owner (TODO.md, 2026-11-17): **Q1 A** timeline node,
**Q2 A** harness-grey line, **Q3 B** first full then short. (The mockup files sit
in `.tentacle/mockups/`, which this planning session could not read; Owner Q3
confirms the reading of Q3 B used below.)

The model-facing text does NOT change: the model needs it, and it is the
durable truth (`core/src/schedule.ts:471-478`).

**Repro** (2026-11-17, on `feat/scheduled-fire-row` = `main` 6f154644), from
`.tentacle/tmp/scheduled-fire-row/repro.ts`:

```ts
import { schedulePromptText } from "../../worktrees/scheduled-fire-row/packages/core/src/schedule.ts";
import { firedScheduleHead as mobHead } from "../../worktrees/scheduled-fire-row/apps/mobile/src/schedule-view.ts";
import { firedScheduleHead as tuiHead } from "../../worktrees/scheduled-fire-row/packages/tui/src/schedule-view.ts";

const job = { id: "sc-1", spec: "at 2026-11-17T15:54", fires: 1, prompt: "saluta l'utente" } as never;
const text = schedulePromptText(job);
const ref = { id: "sc-1", spec: "at 2026-11-17T15:54" };
console.log("text        :", text);
console.log("tui  live   :", JSON.stringify(tuiHead(ref, text)), "+ body", JSON.stringify(text));
console.log("tui  reload :", JSON.stringify(tuiHead(undefined, text)), "+ body", JSON.stringify(text));
console.log("phone live  :", JSON.stringify(mobHead(ref)), "+ body", JSON.stringify(text));
console.log("phone reload:", JSON.stringify(mobHead(undefined)), "+ body", JSON.stringify(text));
```

```
text        : [scheduled sc-1 · at 2026-11-17T15:54 · fire 1] saluta l'utente
tui  live   : "◷ scheduled · sc-1 at 2026-11-17T15:54 · fire 1" + body "[scheduled sc-1 · at 2026-11-17T15:54 · fire 1] saluta l'utente"
tui  reload : "" + body "[scheduled sc-1 · at 2026-11-17T15:54 · fire 1] saluta l'utente"
phone live  : "◷ Scheduled · at 2026-11-17T15:54" + body "[scheduled sc-1 · at 2026-11-17T15:54 · fire 1] saluta l'utente"
phone reload: "" + body "[scheduled sc-1 · at 2026-11-17T15:54 · fire 1] saluta l'utente"
```

Three defects in one table: the body always carries the bracket; the spec is a
raw ISO; live ≠ reload (head present vs absent) and TUI ≠ phone (two head formats).

## Implementation

> **EXECUTOR — BINDING:** the owner revised the design after this plan was written. "### Owner decisions — revision (2026-11-17 ~21:30)" below SUPERSEDES the row text and expansion rules here: a fire renders `◷ Wake <fire time> · <prompt one line…>`, ALWAYS collapsed (tap / ctrl+o expands), for `at` and every `every` fire; the create stays the "Schedule" tool row; no `sc-N`. Where this section says "Scheduled · …" or "full prompt on fire 1", follow the revision.

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**Every fired turn's user text — live and reloaded, on every client — is exactly
`schedulePromptText(job)`, so ONE pure parser of that text is a sufficient,
durable source for the row on all three surfaces.** Verified:

- Produced once: `core/src/schedule.ts:476-478`
  (`` `[scheduled ${job.id} · ${job.spec} · fire ${job.fires}] ${job.prompt}` ``).
- The daemon fires with exactly that text as the turn's only text part:
  `daemon/src/hosted-session.ts:3425-3435` → `prompt(…)` → `turn_start.prompt`
  `hosted-session.ts:2603-2612`; the same parts are the persisted user
  `ChatMessage` (the log stores the conversation, AGENTS §7).
- Live consumers receive it unchanged as `user_message.text`
  (`client/src/mapping.ts:48-57`; TUI `tui/src/state.ts:843-860`; phone
  `apps/mobile/src/transcript.ts:270-285`).
- Reload consumers read `ChatMessage.content` (TUI `tui/src/resume.ts:84-92`;
  phone `apps/mobile/src/transcript-history.ts:113-123`).
- Precedent for exactly this shape (derive a row from a durable text prefix,
  identically on live and reload): `restartPromptOf` (`@tentacle/agent`), used at
  `tui/src/resume.ts:68` and `apps/mobile/src/transcript-history.ts:96`.

Consequence: the display stops depending on the `turn_start.schedule` ref, which
is what makes live = reload by construction.

### Preconditions

- No protocol change, no log/sidecar change: the parser reads text already on
  the wire and on disk. AGENTS §7 protocol and persistence invariants untouched.
- "Logic in pure modules" (§7): parse in `core`, view-model in each client's
  pure `schedule-view.ts`; components only map it to glyphs/colours.
- The phone may import `@tentacle/core` (`apps/mobile/package.json:11`, already
  used by e.g. `apps/mobile/src/diff-view.ts`).
- `job.spec` is `every <interval>` or `at <text>`; an `at` written as a relative
  time is stored as its resolved local minute, an absolute one as the model gave
  it (`core/src/schedule.ts:276-281`). So an `at` spec is a free string whose
  common form is `YYYY-MM-DDTHH:MM` with no zone → reformat the string, never
  `new Date()` it (zone guess = wrong clock on a phone in another zone).
- Ink: blank rows render `" "` (AGENTS §6 gotcha) — the body is never `""` here
  (a `[scheduled …] ` with an empty prompt cannot be created; still guarded, see
  Failure modes).

### Design

1. **Core — one inverse of `schedulePromptText`** (`core/src/schedule.ts`, beside
   it):
   `scheduledPromptOf(text): { id; spec; fire; prompt } | null` — an anchored,
   strict match of the exact format (`^\[scheduled (\S+) · (.+?) · fire (\d+)\] `,
   rest = prompt, multiline-safe). Anything else → `null` (the message is an
   ordinary user message). A round-trip test pins it to `schedulePromptText`, so
   the two can never drift.
   Plus `scheduleSpecText(spec, today)`: `every 10m` → `every 10m`;
   `at 2026-11-17T15:54` → `at 15:54` when the date part equals `today`
   (`YYYY-MM-DD`, the caller's local date), else `at 17 Nov 15:54`; any other
   `at …` / unknown shape → the spec as-is, bounded (honest degradation).
2. **View-model — one decision per client, same shape**
   (`firedRowView(parsed, opts) → { head; body; short }`):
   - head: `scheduled · <specText> · fire N` (TUI) / `Scheduled · <specText>` +
     `fire N` only when N > 1 (phone) — exact wording per the picked mockups;
   - body: the prompt — **full on fire 1, one-line truncated on fire ≥ 2**
     (Q3 B, Owner Q3); the TUI's expand-all (`opts.expandAll`) and a tap on the
     phone show it full;
   - the id `sc-N` is not shown in the head (it is noise to a person; it stays in
     the model's text and in the Session-info list) — Owner Q4.
   The TUI's `firedScheduleHead(ref, text)` and the phone's
   `firedScheduleHead(ref)` are **replaced** by these (they were the ref-based
   heads, `tui/src/schedule-view.ts:273-293`, `apps/mobile/src/schedule-view.ts:96-113`).
3. **TUI render** (`tui/src/render-lines.ts:979-992`, the `user` case): if
   `scheduledPromptOf(item.text)` is non-null, emit **harness-grey lines** (Q2 A,
   `theme.subtle`): `◷ scheduled · every 10m · fire 5` then the body indented
   two spaces — and NOT the `userLines` (`>`-styled) rows. Otherwise unchanged.
   Decided at render from the text, so `state.ts` (live) and `resume.ts`
   (reload) need no change beyond dropping the now-unused `schedule` field.
4. **Phone** — the row stays `kind: "user"` (copy/search/keys unchanged) and
   gains `fired?: FiredView`, set in ONE helper used by both
   `transcript.ts` `user_message` (live) and `transcript-history.ts` (reload);
   `text` becomes the prompt only. `TranscriptRow.tsx` routes a `fired` row to a
   new `FiredRowView`: a **timeline node** (Q1 A) — the same dot + rail geometry
   as the tool/thought rows in the screenshot, a `◷` node, grey head, body text
   below, no bubble. The old in-bubble cyan head (`TranscriptRow.tsx:143-175`)
   is removed.
5. **The `turn_start.schedule` ref** stays on the wire and in `client` (removing
   it is a protocol field removal → a `protocol.d/` note; out of scope, Owner Q2).
   The renderer-side copies (`DisplayItem.schedule`, `UserRow.schedule`) are
   deleted, since nothing reads them.

### Files

In dependency order:

1. `packages/core/src/schedule.ts` — `scheduledPromptOf`, `scheduleSpecText` (+ export from the package index if not barrel-exported).
2. `packages/core/test/schedule.test.ts` — round-trip + rejects.
3. `packages/tui/src/schedule-view.ts` — `firedRowView` replaces `firedScheduleHead`.
4. `packages/tui/src/render-lines.ts` — the `user` case branch.
5. `packages/tui/src/state.ts` — drop `schedule` on the user item (`:33-60`, `:859`).
6. `packages/tui/test/schedule-view.test.ts`, `packages/tui/test/schedule-panel-frames.test.tsx` — update + new frames.
7. `apps/mobile/src/schedule-view.ts` — `firedRowView` replaces `firedScheduleHead`; `userRowOf(text, …)` helper.
8. `apps/mobile/src/transcript-rows.ts` — `UserRow.fired?`, drop `UserRow.schedule`.
9. `apps/mobile/src/transcript.ts`, `apps/mobile/src/transcript-history.ts` — use the helper.
10. `apps/mobile/src/screens/transcript/TranscriptRow.tsx` — `FiredRowView`.
11. `apps/mobile/test/transcript.test.ts`, `apps/mobile/test/schedule-wiring.test.ts` — update + new.
12. `changelog.d/scheduled-fire-row.changed.md` — one bullet.

### Failure modes

- **A person types the prefix themselves** → it renders as a fired row. Display
  only; nothing is hidden (the prompt text is still all shown, only re-laid
  out); no effect on the laptop. Accepted (Owner Q1: no trust gate).
- **Pod / untrusted daemon forges a fired message** → same as above: a label, no
  effect, and pods never schedule (`AgentContext.schedules` is `null` there,
  `core/src/schedule.ts` P1 comment). Owner Q1.
- **Prompt containing `]`, ` · `, newlines** → the anchored, lazy match stops at
  the first `] ` after `fire N`; the prompt is the rest verbatim. Tested.
- **Empty prompt** (cannot be created, but an old log could) → body `""` → no
  body row (TUI: never an empty `<Text>`, §6), head alone.
- **Format drift** (someone edits `schedulePromptText`) → the round-trip test
  fails in `core`.
- **Older logs** → same text format since cron-tool shipped, so they render
  cleanly with no migration.
- **`at` spec not ISO** (model wrote `at tomorrow 9:00`, accepted by the parser
  upstream) → shown as given, bounded; never a guessed time.
- **Version skew** (new client, old daemon; old client, new daemon) → nothing
  changes on the wire; an old client keeps its current rendering.
- **Narrow width** → head truncated with `truncateCells` (TUI) /
  `numberOfLines={1}` (phone), body wraps (fire 1) or truncates (fire ≥ 2).

### Tests

Red first (§9): each new assertion below fails on current code (the repro output
above is the red evidence for the render ones).

- `core/test/schedule.test.ts`: `scheduledPromptOf(schedulePromptText(job))`
  returns `{id, spec, fire, prompt}` for `every` and `at` jobs; prompts with `]`,
  ` · `, `\n`; `null` for an ordinary message, a mid-text `[scheduled`, a missing
  `fire N`. `scheduleSpecText` today / other day / non-ISO.
- TUI `schedule-view.test.ts`: `firedRowView` full on fire 1, short on fire 5,
  full with `expandAll`.
- TUI frames (`schedule-panel-frames.test.tsx` pattern, ink-testing-library):
  a `user_message` with the fired text and a reload (`resume.ts`) of the same
  `ChatMessage` produce **identical frames**, containing `◷ scheduled · at 15:54 ·
  fire 1` and NOT `[scheduled`. This is the exact property (live = reload).
- Phone `transcript.test.ts`: the live `user_message` fold and the
  `transcript-history` projection of the same message yield deep-equal rows
  (`fired` set, `text` = prompt), and an ordinary message has no `fired`.
- Mutation check (§9): make `scheduledPromptOf` always return `null` → the frame
  and row tests fail; revert.

### Owner questions

1. **Trust gate on the parse?** The old ref was shown only for a trusted daemon. *Rec: no gate* — the row is display-only and hides nothing; a typed or pod-forged prefix just gets a label.
2. **The `turn_start.schedule` wire ref** is no longer read by any renderer. *Rec: leave it on the wire in this task*; remove it later with a `protocol.d/` note if you want it gone.
3. **Q3 B "first full then short"**, read here as: the prompt shows in full on fire 1 and as one line on fire ≥ 2 (expand-all/tap opens it). *Rec: confirm*, or correct it against the mockup.
4. **Head content:** hide the id `sc-N`, and on the phone hide `fire 1`. *Rec: yes* — `◷ scheduled · every 10m · fire 5` / `◷ scheduled · at 15:54`; the id stays in the model text and in Session info.
5. **`at` time format:** `at 15:54` when it is today, `at 17 Nov 15:54` otherwise, with no time zone conversion (the daemon's wall clock as written). *Rec: yes.*

### Owner decisions (2026-11-17)
- Phone, recurring fire ≥ 2: the head shows the FIRE time instead of the count — `Scheduled · every 10m · 16:14`, not `Scheduled · every 10m · fire 2`. The planner must source that time from data the log already carries for the fired turn (e.g. the turn marker / entry timestamp), never from parsing the model text; if no such field exists, say so in the plan and propose the smallest addition. Same local short format as Q5.
- Owner questions 1–5: all recommendations accepted (label "Scheduled", full prompt under fire 1, no `sc-N`, `at 15:54` / `at 17 Nov 15:54`). Implementation APPROVED; execution after the owner's pause.
*— recorded by claude-opus-5-5 (orchestrator), 2026-11-17*

### Owner decisions — revision (2026-11-17 ~21:30, SUPERSEDES the label/expansion parts above)
- Creating a wake (the agent's schedule tool call) shows as the tool row "Schedule" (unchanged).
- A wake firing shows as `Wake 15:54 · <prompt, one line, truncated…>` — `15:54` = the FIRE time (local short format of Q5), for `at` AND for every fire of an `every` wake (this replaces both `Scheduled · at 15:54` and `Scheduled · every 10m · 16:14`).
- ALWAYS collapsed: nothing is expanded unless the user taps (phone) / expands (TUI: ctrl+o). This replaces Q3 "full prompt under fire 1".
- Mac TUI follows the same text (`◷ Wake 15:54 · <prompt…>`, harness-grey) for parity — orchestrator's reading; confirm with the owner if the planner sees a reason to differ.
- Q1, Q2, Q4 (no `sc-N`), Q5 (time format) stand.
*— recorded by claude-opus-5-5 (orchestrator), 2026-11-17*

## Execution

### 1. Load-bearing check — PASS

Re-ran the Context **Repro** verbatim on this branch (`main` 6f154644 +
plan/orchestrator commits; `.tentacle/tmp/scheduled-fire-row/repro.ts`,
`bun run repro.ts`), output unchanged from the doc:

```
text        : [scheduled sc-1 · at 2026-11-17T15:54 · fire 1] saluta l'utente
tui  live   : "◷ scheduled · sc-1 at 2026-11-17T15:54 · fire 1" + body "[scheduled sc-1 · at …] …"
tui  reload : "" + body "[scheduled sc-1 · at …] saluta l'utente"
phone live  : "◷ Scheduled · at 2026-11-17T15:54" + body "[scheduled sc-1 · at …] saluta l'utente"
phone reload: "" + body "[scheduled sc-1 · at …] saluta l'utente"
```

So the capability is genuinely missing: bracket in every body, raw ISO, live ≠
reload, TUI ≠ phone. And the Implementation's load-bearing assumption is
**verified against the code**: the fired turn's only text part is exactly
`schedulePromptText` (`daemon/src/hosted-session.ts:3427`), and that same text is
the persisted user `ChatMessage` (`core/src/schedule.ts:476-478`) that both
reload paths project (`tui/src/resume.ts:74` via `messagesToItems`;
`apps/mobile/src/transcript-history.ts:82` via `historyRows`). One pure parser is
indeed a sufficient, durable source — **for the bracket, the spec and the fire
ordinal**.

### 2. BLOCKED on the binding revision's fire time — owner decision needed

The revision requires the row to be
`◷ Wake <fire time> · <prompt one line…>` where `<fire time>` is **the instant
the wake fired**, "for `at` AND for every fire of an `every` wake", identical
live / after reload / on the Mac (and the earlier owner decision of 2026-11-17
adds: "source that time from data the log already carries for the fired turn …
never from parsing the model text; if no such field exists, say so in the plan
and propose the smallest addition").

**No such field exists on any client path.** Verified:

- The wire ref carries no instant — only `{id, spec}`
  (`protocol/src/updates.ts:274`), and it is live-only anyway (absent on reload
  by construction, which is the plan's whole starting point).
- The spec string carries no clock for `every`: it is literally `every 10m`
  (`core/src/schedule.ts:77-96`; `spec` is the model's request). For `at` the
  spec does carry one (`at 2026-11-17T15:54`), so `at` alone is satisfiable by
  reformatting — which is all the approved Implementation's `scheduleSpecText`
  does.
- The snapshot's `times` (`protocol/src/session.ts:915`) is the closest thing,
  but (a) a log `base` zeroes every one of them — `this.times =
  messages.map(() => 0)` at `daemon/src/session-log.ts:371-374`, i.e. exactly the
  reload/resume/restart path — and (b) the TUI has no per-item time at all
  (`tui/src/state.ts:32-59`, `UserItem` has `text`/`images`/`documents`/
  `restart`/`schedule` and nothing temporal), so phone/Mac parity is impossible
  from it even when the values are real.
- The log entry envelope's `ts` **is** the arrival instant, but the laptop's
  reader keeps only `{inc, head, messages, digests}` (`client/src/session-log-reader.ts:198`),
  and a resumed `SessionRecord` has no per-message times
  (`agent/src/session-store.ts:15-37`). The datum is written and then dropped.

Consequently `Wake 15:54` renders for an `every` wake **live only** — it would
again be live ≠ reload, the exact defect this task exists to kill. I did not
implement a head I know to be wrong, and did not reach for a value outside the
approved Implementation.

**Smallest addition that satisfies the revision (proposal, NOT implemented):**
one FAIL-SOFT display-only field on the user message, the `note`/`media`/
`compacted` pattern (`protocol/src/session.ts:95-141`):
`scheduled?: { id, spec, fire, at }`, `.catch(undefined)`, set by the daemon in
`fireSchedule` (`daemon/src/hosted-session.ts:3412-3437`) from the instant it
actually fires. Being on `ChatMessage` it rides the CRITICAL `message` entry, so
the log carries it and **every** reload path gets it — live = reload = phone =
Mac by construction. Additive + optional on strip schemas, so no
`PROTOCOL_VERSION` bump and no `protocol.d/` note; an older build drops the
unknown field and keeps today's rendering (honest degradation). But it puts a
new field on the **CRITICAL message entry** and on the on-disk format, which
AGENTS §7 reserves to the owner — hence this stop rather than a unilateral edit.

### 3. Nothing else was changed

No production code, test or changelog fragment was written — every slice of the
plan depends on the head's wording, so implementing against the superseded
`Scheduled · at 15:54` / `· fire N` text would have built the wrong thing and
cost a rewrite. No `changelog.d/` fragment: no user-visible change was made.
Tree otherwise untouched (this doc excepted). Plan left as written — the
contradiction is with available DATA, not with the code, so the fix is a plan
(and protocol/format) decision, not an executor edit.

**Per-slice status:** S1 core parser — BLOCKED (its `scheduleSpecText` is sound,
but the view-model contract it feeds is undecided). S2 TUI view-model + render —
BLOCKED. S3 phone view-model + row — BLOCKED. S4 tests/frames — BLOCKED.
Changelog — BLOCKED. **Mutations:** none run (no code to mutate). **Gate:** no
code changed, so `tsc`/`lint`/`test` remain at the untouched baseline; nothing
introduced.

**Decision needed (one line):** approve `ChatMessage.scheduled{id,spec,fire,at}`
(FAIL-SOFT, daemon-set) as the durable fire instant — then this task proceeds as
planned with `Wake <fire time>` on all three surfaces — **or** keep the plan's
approved no-persistence design, in which case the revision must be narrowed to
`at` wakes (fire time) + `every` wakes (`every 10m · fire N`), accepting that a
recurring wake shows no clock.

*— claude-opus-5-5, 2026-11-17 (executor; CLI settings model `opus`, exact build suffix not readable from the environment)*

### Owner decision (2026-11-18 ~00:20) — persisted fire instant
APPROVED: option 1 of Execution §2. Add the FAIL-SOFT, display-only optional field `scheduled?: { id, spec, fire, at }` on the user `ChatMessage` a wake produces (protocol `session.ts` message schema, `.catch(undefined)`, the `note`/`media`/`compacted` pattern), set by the daemon in `fireSchedule` from the instant it actually fires; it rides the critical `message` entry, so live = reload = phone = Mac. Additive on strip schemas → no PROTOCOL_VERSION bump (confirm, and write a protocol.d note only if the executor finds a real break). Old logs without the field fall back to the parser (`at` → its spec time; `every` → `#N`). The executor implements S1–S4 with this field; tests must cover: live, reload from log, old log without the field, unknown-field tolerance of an older reader.
*— recorded by claude-opus-5-5 (orchestrator), 2026-11-18*

### Round 2 — as built (on the 2026-11-18 owner decision)

**Load-bearing re-check — PASS.** Re-read on this branch: the fire's only text
part is still `schedulePromptText(job)` (`daemon/src/hosted-session.ts` `fireSchedule`),
`prompt()` → `session.send(text, …, opts)` → the agent pushes ONE user
`ChatMessage` (`agent/src/session.ts` `send`), and both reload paths still project
`ChatMessage` (`tui/src/resume.ts` `itemsOf`, `apps/mobile/src/transcript-history.ts`
`historyRows`). No field-by-field copy of a message exists between the agent and
the log (`rg "\.media\b"` shows only renderers), so a new optional field rides
the critical `message` entry untouched.

**Slices, in dependency order:**

1. **core** — new `packages/core/src/scheduled-fire.ts` (exported from the index):
   `ScheduledFire {id, spec, fire, at}`, `ScheduledRef` (fire/at optional — an older
   daemon's ref), `scheduledPromptOf` (the anchored inverse of `schedulePromptText`),
   `wakeTimeText` (instant → `15:54` today / `17 Nov 15:54`, viewer's local clock),
   `scheduleFallbackWhen` (no record: `at YYYY-MM-DDTHH:MM` reformatted as a
   STRING, `every` → `#N`, anything else as given, ≤ 32), `firedWakeOf` (record
   first, prefix second — the `compactionOf` shape), `firedWakeLine`.
   `ChatMessage.scheduled?: ScheduledFire` (`core/src/model.ts`).
2. **protocol** — `ScheduledFireSchema` (`session.ts`, bounds = `ScheduleIdSchema` /
   `SCHEDULE_LABEL_MAX`); `ChatMessage.scheduled` = `.optional().catch(undefined)`
   (FAIL-SOFT); `turn_start.schedule` gains optional `fire`/`at` (`updates.ts`).
   `protocol.json` regenerated (`bun run protocol:bump`, no notes).
   **No `protocol.d/` note:** both changes are optional fields on strip schemas — an
   older peer drops them (tested), a newer client accepts an older daemon's
   `{id, spec}` (tested). No break found.
3. **agent + daemon** — `SendOptions.scheduled` stored on the pushed user message;
   `fireSchedule` passes `{id, spec, fire: job.fires, at: this.now()}` (the job is
   already advanced, so `fire ≥ 1`); `prompt()` sends it on `turn_start` AND as
   `scheduled` to `send`.
4. **client** — `firedScheduleRef` keeps `fire`/`at` (still behind the
   `daemonWakes` trust gate); `user_message.schedule` / `startForeign` typed `ScheduledRef`.
5. **TUI** — `firedRowLines` (`tui/src/schedule-view.ts`) **replaces**
   `firedScheduleHead`: collapsed `◷ Wake 16:14 · <prompt one line>` cut to width;
   Ctrl+O (`expandAll`) → `◷ Wake 16:14` + the prompt's lines indented (blank → `" "`).
   `render-lines.ts` `user` case returns them in `theme.subtle` INSTEAD of the `>`
   rows; `RenderOptions.now?` (default `Date.now()`). `resume.ts` sets
   `schedule: m.scheduled`; `UserItem.schedule` / the event typed `ScheduledRef`.
6. **phone** — `firedRowView` (`apps/mobile/src/schedule-view.ts`) **replaces**
   `firedScheduleHead` → `{name: "Wake 16:14", subtitle, body, a11yLabel}`.
   `UserRow.schedule: ScheduledRef`, set live (`transcript.ts`, unchanged line) and
   on reload (`transcript-history.ts`: `m.scheduled`). `TranscriptRow.tsx` routes a
   fired `user` row to `FiredRowView`: `StepNode` with a new `wake` node kind (`◷`,
   `palette.sec`, `ui/StepNode.tsx`), lone thread, collapsed until tapped (local
   `useState`), the full prompt as the body. The in-bubble cyan head is removed.
7. `changelog.d/scheduled-fire-row.changed.md`.

**Drift from the Implementation (and why):**
- The superseded wording (`scheduled · at 15:54 · fire N`, full prompt on fire 1)
  is replaced by the binding revision (`Wake <fire time>`, always collapsed) plus the
  approved persisted field — so `DisplayItem.schedule` / `UserRow.schedule` are
  **kept and widened** to `ScheduledRef` rather than deleted (Design 5): they now
  carry the record on BOTH paths, which is what makes live = reload.
- Parser lives in its own `core/src/scheduled-fire.ts`, not inside `schedule.ts`
  (one display concern, one module; the round-trip test still pins it to
  `schedulePromptText`).
- Phone: the row's `text` stays the FULL message text (prefix included) instead of
  the prompt only; the view strips the prefix at render. Reason: the fallback for
  an older log must parse the prefix, and keeping the row data raw keeps live and
  reload rows field-identical. Cost: a long-press copy of the node's body copies
  the prompt (body = prompt), but a row-level copy action, if any reads
  `row.text`, would include the prefix — unverified, no such action found on the
  fired node.
- Phone node: lone thread (not joined into the tool/thought rail of
  `tool-steps.ts`) — joining would widen the change into the step-threading
  module; out of scope.
- "today" is read at render (`Date.now()`); a TUI row cached across midnight keeps
  `HH:MM` until it re-renders (documented on `RenderOptions.now`).
- Trust: the live ref stays behind `daemonWakes`; the stored field has no gate
  (owner Q1). On an untrusted (pod) daemon the live row falls back to the prefix
  while a laptop-log reload would show the stored time — pods never schedule, so
  this is a forged-label case only.

**Repro after** (`.tentacle/tmp/scheduled-fire-row/after.ts`, every 10m, fire 2, fired 16:14):
```
tui  live (ref)     : ["◷ Wake 16:14 · saluta l'utente"]
tui  reload (stored): ["◷ Wake 16:14 · saluta l'utente"]
tui  old log        : ["◷ Wake #2 · saluta l'utente"]
phone live/reload   : {"name":"Wake 16:14","subtitle":"saluta l'utente","body":"saluta l'utente","a11yLabel":"Wake 16:14: saluta l'utente"}
phone old log       : "Wake #2"
```

**Tests (owner's four + plan's):** live — daemon T-D1b (`turn_start.schedule` =
`{id, spec, fire:1, at:T0+10m}`), TUI frame, phone fold; reload from log — daemon
T-D1b (snapshot's stored user message carries the same record), TUI frame
(`history_reset` → identical `◷` rows), phone `history` fold deep-equal to live;
old log without the field — core/TUI/phone `#N` and `at` spec time; unknown-field
tolerance of an older reader — `protocol/test/scheduled-fire.test.ts` (older schema
strips it; malformed value dropped, critical entry still loads; old `{id, spec}` ref
parses). Model never sees it — `providers/test/compaction-fact.test.ts` (Anthropic
payload byte-identical). New files: `core/test/scheduled-fire.test.ts`,
`protocol/test/scheduled-fire.test.ts`; updated: daemon `schedules.test.ts`, client
`schedules.test.ts`, TUI `schedule-view.test.ts` + `schedule-panel-frames.test.tsx`,
mobile `schedule-view.test.ts` + `schedule-wiring.test.ts` + `transcript.test.ts`.

**Red / mutations (each reverted, then green):**
| # | mutation | result |
|---|---|---|
| M1 | `scheduledPromptOf` always null | 14 fail (core round-trips, TUI view + both frame tests, phone view) |
| M2 | `resume.ts` drops `schedule: m.scheduled` | TUI "live and reloaded … SAME row" fails |
| M3 | `transcript-history.ts` drops it | phone "SAME live and reloaded" fails |
| M4 | daemon drops `scheduled` into `send` | daemon T-D1b fails |
| M5 | protocol drops `.catch(undefined)` | 2 protocol fail-soft tests fail |
| M6 | client drops the `at` spread | client "keeps the fire's ordinal and instant" fails |
Render red on the old code = the Context repro (bracket in every body, live ≠ reload).

**Gate:** `bun run typecheck` clean (root + mobile + relay) · `bun run lint` clean
(2061 files, 0 diagnostics) · `bun test` **14993 pass, 5 skip, 0 fail** (the skips
are all env-gated files this branch does not touch: live k8s/docker, confinement,
ws-server, session-hop docker — AGENTS §6's "three" is stale, not a regression).

**Per-slice:** S1 core — DONE · S2 protocol — DONE · S3 agent/daemon — DONE ·
S4 client — DONE · S5 TUI — DONE · S6 phone — DONE (not run on a device: the node's
geometry/glyph alignment is unverified visually; verify with an iOS build) ·
changelog — DONE.

*— claude-opus-5-5, 2026-11-18 (executor)*

### Round 3 — verification of the interrupted WIP (`ac3dbfe0`)

The Round 2 edits were committed by the orchestrator as "partial … (interrupted)";
this pass checked whether anything was left half-done. **Nothing was:** every file
Round 2 lists is in `git diff main...HEAD`, and no production code was changed in
this round (the doc is the only edit).

- `bun run typecheck` clean (root + mobile + relay); `bun run lint` clean (2077
  files, 0 diagnostics); the 11 touched/related test files 182 pass / 0 fail
  (includes `protocol/test/json-schema.test.ts`, so `protocol.json` has not drifted).
- Mutations re-run here (Edit-applied, then reverted; `git status` clean afterwards):
  | # | mutation | result |
  |---|---|---|
  | M1 | `scheduledPromptOf` always returns `null` | 15 fail across core, TUI view + frames, phone view + transcript |
  | M2+M3 | `resume.ts` and `transcript-history.ts` drop `schedule: m.scheduled` (M1 reverted) | exactly the 2 live = reload tests fail (TUI frame, phone fold) |
- Full `bun test`: **15162 pass, 5 skip, 0 fail** (the same env-gated skips as Round 2).

**Per-slice:** S1–S6 + changelog — DONE (as in Round 2). Still not checked on a
device: how the phone node looks (needs an iOS build).

*— claude-opus-5-5, 2026-11-18 (executor, round 3)*

### Fix round 1

On review round 2 (one MEDIUM; no HIGH).

**M1 (MEDIUM): Ctrl+O never toggled a fired row — FIXED.** Root cause: `itemRows`
keyed every non-tool item on the `collapsed` slot only, so a fired row, whose
layout depends on `expandAll`, replayed whatever was painted first.
- `packages/tui/src/schedule-view.ts` `isFiredWake(text, schedule)`: a pure
  predicate (`firedWakeOf(…, 0) !== null`). Whether a message is fired never depends on the clock.
- `packages/tui/src/render-lines.ts` `itemRows` `expandMatters`: also true for
  `kind: "user"` with `isFiredWake`. Typed prompts keep the width-only cache.
- Test `packages/tui/test/render-lines.test.ts` "fired scheduled wake row — Ctrl+O
  through the row cache": lays out the SAME item through `transcriptRows` twice,
  with the flag flipped in both orders, plus a check that a typed prompt does not change.
  - **Red on the old code**, failing on the assertion: off→on received
    `["◷ Wake #2 · line one line two"]`, expected 3 rows; on→off received
    3 rows, expected 1. 2 fail / 1 pass.
  - **Green** after the fix: `render-lines` + `schedule-view` +
    `schedule-panel-frames`, 173 pass / 0 fail.
- **Mutation:** with `isFiredWake` forced to `return false && …`, the same
  2 tests fail (the off→on and on→off cases). After the revert, 3/3 pass.

**Gate:** `bunx tsc --noEmit` clean · `bun run lint` clean (2077 files) · full `bun test`
**15165 pass, 5 skip, 0 fail** (the same env-gated skips as Round 2/3).

*— claude-opus-5-5, 2026-11-18 (executor, fix round 1)*

## Review

**Verdict: REQUEST-CHANGES** (not mergeable: no code, the feature is not built;
the executor's stop is correct and its premises hold).

**Scope.** `git diff main...HEAD` = this doc only (+338). No production code, test,
changelog fragment or `protocol.d/` note. Nothing to mutate (§9 not applicable).

**Gate.** `bun run lint` clean (2047 files, 0 diagnostics); `bun run typecheck`
clean (root + mobile + relay). No test file touched, so no test run is attributable.

**Findings.**
1. MEDIUM — the branch delivers none of S1–S4 (Execution §3). It must not merge as
   a `feat`; it waits on the owner decision in Execution §2.
2. MEDIUM — attribution mismatch: commit `cf03dbcf` is titled `exec (deepseek)`,
   while Execution is signed `claude-opus-5-5`. §10 signing exists to track which
   model did what; one of the two is wrong — fix it before merge.
3. Missed option (put to the owner): the fire instant can also go in the
   daemon-authored durable prefix (`schedulePromptText`, `core/src/schedule.ts:476-478`,
   e.g. `· fired 16:14`). That prefix is already the plan's parse source, it adds
   no message/format field, and it is written by the daemon, not the model, so it is
   arguably outside "never from parsing the model text". Its cost: the model sees
   the wall clock. Weigh it against the proposed `ChatMessage.scheduled` field.

**Premise table (Execution §2).** TRUE: `updates.ts:274` ref is `{id, spec}`;
`session-log.ts:374` a base zeroes `times`, and `times` exist only in memory
(`commitTimes` 143-153, nothing restores them from entry `ts` on restart);
`session-log-reader.ts:198` `LogState` keeps no `ts`; `tui/src/state.ts:32-59`
`UserItem` has no time field; `hosted-session.ts:3412-3437` fire passes only
`schedulePromptText` + `{id, spec}`. So `Wake <fire time>` for `every` cannot match
on live vs reload with today's data. The claim holds.

**Attacks tried.** (a) Is fire time recoverable from snapshot `times` on reload? No:
zeroed on a base and lost on a restart. (b) From the `every` spec + ordinal? No:
there's no anchor instant. (c) Did the executor change anything outside the doc?
No (`--stat` excluding docs is empty). (d) Did the proposed field need a bump?
Additive and optional on a strip schema, so no bump. Correct per §7, but it is a
CRITICAL-entry/on-disk change, so asking the owner first was right.

**Executor behaviour.** Disciplined: re-ran the repro, verified the load-bearing
assumption, found a binding revision unimplementable from the available data,
stopped and escalated with one decision rather than building a wrong head. Only
fault: finding 2.

Same model family as the doc's signed executor (fresh context only), so blind
spots may be shared.

*— claude-opus-5-5, 2026-11-17*

## Review

**Verdict: REQUEST-CHANGES** (round 2, the built code `main...HEAD`).

**Gate.** 11 touched test files: 182 pass / 0 fail. `bun run lint` clean (2077
files). `bun run typecheck` clean (root + mobile + relay). I did not re-run the full suite.

**Findings.**
1. MEDIUM — Ctrl+O never toggles a fired row in the real TUI.
   `render-lines.ts` `itemRows` (~1238-1248) caches every non-tool item in the
   `"collapsed"` slot only (`expandMatters` is false for `kind: "user"`), but
   `itemLinesAt`'s new branch (`render-lines.ts:996-1006`) now depends on
   `expandAll`. Repro (`.tentacle/tmp/scheduled-fire-row/cache.ts`, same item object,
   `transcriptRows` with expandAll false and then true):
   `collapsed : ["◷ Wake #2 · line one line two"]` /
   `ctrl+o on : ["◷ Wake #2 · line one line two"]` (a fresh object gives
   `["◷ Wake #2","  line one","  line two"]`). The reverse also holds: a row first
   painted with Ctrl+O on stays expanded. The owner's revision requires "ctrl+o
   expands". The tests miss it because `schedule-view.test.ts` calls `firedRowLines`
   directly and the frame test never toggles Ctrl+O on a mounted App. Fix: make
   `expandMatters` true for a user item that `firedWakeOf` recognises, and add a
   test that renders the same item twice with the flag flipped.

**Holds.** The load-bearing claim holds: `fireSchedule` (`hosted-session.ts:3494-3505`)
stamps `{id, spec≤200, fire≥1, at: now()}` and that one object reaches
`turn_start` and `Session.send`, so it lands on the stored message.
`ChatMessage.scheduled` is `.optional().catch(undefined)`. A bad value is dropped
and the critical entry still loads (the protocol test pins this). No
`PROTOCOL_VERSION` bump is needed: both changes add optional fields to strip schemas.
Trust: the live ref stays behind `daemonWakes`, which is on for the worker,
`connect` and the phone. The stored field is not gated (owner Q1), but
only its `at` is painted and the prompt goes through `oneLine`/`scheduleLabel`.
The provider payload is unchanged (`compaction-fact.test.ts`).

**Mutation (§9).** Making `firedWakeOf` ignore the stored record made 5 tests fail
(core, TUI view ×2, TUI frame, phone view). After the revert, `git status` is clean.

**Executor behaviour.** Faithful to the owner's decision. The as-built record and
the M1–M6 mutation table are honest. It missed the cache interaction, an
integration seam that no unit test covers. Reviewer is the same model family (fresh
context only).

*— claude-opus-5-5, 2026-11-18*
