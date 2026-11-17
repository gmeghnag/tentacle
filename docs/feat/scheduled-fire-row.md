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

## Review
