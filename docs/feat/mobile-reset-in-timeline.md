# feat/mobile-reset-in-timeline — Context reset and compaction as timeline steps (iPhone)

> **Status:** implementation — **APPROVED (owner 25/11, answers 1A 2A 3A 4A)** (4 owner questions open, below)
> **Branch:** `feat/mobile-reset-in-timeline`
> **Size:** M (3 DeepSeek slices, S–M each) · **Blast:** contained (app only: no protocol, persistence, daemon or TUI change) · **Suited:** Opus mockups/plan → DeepSeek exec per slice → standard review (one Opus round for the group, `fewer-reviews`)
> **Changelog:** `changelog.d/mobile-reset-in-timeline.changed.md`

## Context

*— claude-opus-5-5, 2026-11-25*

**Owner, 2026-11-23 ~13:15 (iPhone screenshot), `TODO.md`:** today a context reset is
a divider («↻ context reset by the model») followed by a big user-style bubble
«restart prompt» with the whole prompt, breaking the transcript. Context reset
AND compaction become STEPS in the timeline (the step rail, like Thought / tool
rows), collapsed to one line; tapping a reset shows its restart prompt as a
rendered markdown block (a compaction: its summary, the same way). **MOBILE ONLY**
(owner 23/11 ~13:20: the TUI stays as it is). Mockups ≥ 2 variants first.

**Evidence — where today's look comes from (all `apps/mobile/src`):**

- The history mapper turns a reset's first user message into TWO rows: a
  separator notice `CONTEXT_RESET_SEPARATOR` (`transcript-history.ts:22`,
  pushed at `:112-117`) and a `user` row `{restart: true}` holding the whole
  prompt (`:118-125`). `restartPromptOf` (`:28-35`) is the app's copy of the
  agent's (`packages/agent/src/context-reset.ts`), pinned by
  `test/transcript-parity.test.ts:191-192`.
- The bubble: `UserRow.restart` (`transcript-rows.ts:62-63`) → the
  `restart prompt` caption inside the user bubble
  (`screens/transcript/TranscriptRow.tsx:367-369`), plain text, right-aligned
  like a message the owner typed; `media-layout.ts:244` forces the bubble.
- A compaction is ONE separator notice `compacted · ctx A → B`
  (`compactionSeparatorRow`, `transcript-history.ts:45-49`, from
  `@tentacle/core` `compactionOf`/`compactionSeparatorText`,
  `packages/core/src/compaction-view.ts:25-46`). Its summary is deliberately
  NOT shown ("a phone notice has no expand", `transcript-history.ts:42-43`).
  Drawn by `NoticeRowView`'s `separator` branch (`TranscriptRow.tsx:886-901`:
  rule · text · rule).
- Live paths, both through `historyRows`: the turn's `context_reset` stream event
  appends (`transcript.ts:697-700`); a `history{reason}` input appends for a
  reset and pushes the compaction separator for ANOTHER device's compaction
  only (`transcript.ts:546-558` — `own === true ? state`). THIS phone's
  successful `/compact` leaves no transcript row at all: `compactOutcome({ok:true})`
  is `null` (`compact-slot.ts:96-99`) → only the footer's `Compacted ✓` for 3 s
  (`session-screen-controller.ts:2183-2201`). A reopen then shows the separator.
- Live, the model's `context_reset` CALL is also a tool step: the agent yields
  a display-only `tool_result` «Context reset — continuing from the restart
  prompt.» and then the `context_reset` event (`packages/agent/src/agent.ts:2771-2791`);
  the call is discarded with the old history, so a REOPEN has no such step.
- The step rail already has the exact precedent: a fired scheduled wake is a
  `◷` step node instead of a bubble, collapsed, tap → its prompt
  (`FiredRowView`, `TranscriptRow.tsx:431-466`, docs/feat/scheduled-fire-row.md).
  The rail's pure layout is `tool-steps.ts` `stepLayout` (`:123-221`); the
  open/show-all state is per row key in the screen
  (`screens/SessionScreen.tsx:781-821`, `toggleOpen`/`isOpen`, `tool-steps.ts:262-270`).

**Repro (feat: the capability is missing), 2026-11-25:** the current shape is
pinned by the app's own tests — `test/transcript.test.ts:448-462` (a reset ⇒
`rows[1]` notice `separator`, `rows[2]` user `restart: true`),
`test/transcript-reload.test.ts:110-129` and `test/transcript.test.ts:432`
(compaction ⇒ notice `separator`), `test/row-times.test.ts:80-89` (the restart
row carries the reset message's time). The «Oggi» frame of the mockup draws
exactly that sequence. The executor re-runs those four files on `main` before
any edit (`bun test apps/mobile/test/transcript.test.ts apps/mobile/test/transcript-reload.test.ts apps/mobile/test/row-times.test.ts apps/mobile/test/notice-row.test.ts`).

**Mockups:** `.tentacle/mockups/mobile-reset-in-timeline/index.inline.html`
(source `index.html`, screenshots in `shots/`; working copy in
`.tentacle/tmp/mobile-reset-in-timeline/mockups/`). Every frame light + dark,
collapsed AND expanded; `?nuovo=1` outlines what the kit does not have.

### Owner questions

1. **The step itself (collapsed / expanded).**
   **A ★** — a step of the rail like `Thought`/`Wake`: a thin symbol in the
   dot's place (`↺` reset, `⤡` compaction, SF Symbols light), the name in grey
   (`Context reset` / `Compacted`), then in mono grey the restart prompt's first
   line (italic) or `ctx 182k → 9k`; the thread continues above and below.
   **B** — a «boundary» step: same symbol and name, then a hairline to the right
   edge (keeps the "the model forgot everything above" meaning), out of the
   thread, no first line. *Recommendation: A* — exactly "a step like Thought /
   tool", one line, and the first line already says what it restarts from.
2. **The expanded body (a long prompt or summary).**
   **A ★** — markdown in secondary grey (system info, like the Wake body), the
   first 12 source lines then `… +N more lines · show all` (the tool output's
   own "show all"). **B** — markdown in the label colour, always whole.
   *Recommendation: A* — grey = system info (colour-blind-safe: position and
   the step shape carry the meaning, the grey only reinforces), and a 300-line
   prompt never floods the chat on a stray tap.
3. **Live: the model's `context_reset` call.**
   **A ★** — while it runs it is a normal running tool step; when the reset
   lands, that step is replaced by the `↺ Context reset` step: one node, the
   same thing a reopen shows. A REFUSED or FAILED call stays an ordinary tool
   step with its error (no reset happened). **B** — both stay: the `Context
   reset ✓` tool step, then the `↺` step under it (a reopen shows only `↺`).
   *Recommendation: A* (one fact, one node; live = reopen).
4. **This phone's own `/compact`.**
   **A ★** — a successful compaction started here also leaves the `⤡ Compacted`
   step (the footer's `Compacted ✓` 3 s is unchanged). **B** — as today: no row
   here; the step appears only on other devices and after a reopen.
   *Recommendation: A* (today it is the only path where the chat says nothing
   until a reopen).

### Owner answers

Owner 2026-11-25 ~09:20, from the mockups (`.tentacle/mockups/mobile-reset-in-timeline/`): **1 A** (a rail step: thin `↺` / `⤡` glyph + first line of the prompt, or `ctx 182k → 9k`) · **2 A** (open body: neutral-grey markdown, first 12 lines + «show all») · **3 A** (live: the `context_reset` call merges into the reset step — one node, as after a reopen) · **4 A** (the phone's own `/compact` leaves a `⤡ Compacted` step at once). Plan APPROVED (owner).

*— claude-opus-5-5 (orchestrator, recording the owner's answers), 2026-11-25*

## Implementation

*— claude-opus-5-5, 2026-11-25*

**APPROVED (owner 25/11, answers 1A 2A 3A 4A)** — written for the recommended answers (1A 2A 3A 4A); each other
answer is a local swap, noted inline as *(Qn-B: …)*.

### Load-bearing assumption

**Both events are recognisable on the phone from the `ChatMessage`s it already
receives, on every path (live, another device, resync, reopen), with NO protocol
or daemon change.** Proof:
- Every path builds rows through ONE function, `historyRows`
  (`transcript-history.ts:96`): a reset's live stream event → `appendHistory`
  (`transcript.ts:697-700` → `:464-470`), a `history{reason: "context_reset"}`
  → `appendHistory` (`:547-549`), a resync/reopen → `withHistory` (`:473-485`).
- A reset is its first user message, read back by `restartPromptOf`
  (`transcript-history.ts:28-35`, the agent's own rule, parity-pinned), whose
  body is exactly the model's prompt (`packages/agent/src/context-reset.ts`
  `restartMessage`).
- A compaction is the summary message `compactionOf(m) !== null`
  (`packages/core/src/compaction-view.ts:25-33`; structural `compacted` figures,
  or the `COMPACTION_SUMMARY_HEAD` line for a legacy one), whose content is
  `HEAD\n\n<summary>[\n\n<running jobs>][\n\n<skills note>]`
  (`packages/agent/src/compact.ts:342`). The only path without messages today
  is this phone's own compaction, and it HAS them: the `history` input carries
  `messages` with `own: true` (`transcript.ts:84-86`, `:551-557`).

### Preconditions

- Per-key open / show-all state already exists for ANY row and survives cell
  recycling (`SessionScreen.tsx:795-821`, `StepProps`, `TranscriptRow.tsx:117-127`).
- A text delta only extends the LAST row when it is an assistant row
  (`lastTextRow`, `transcript.ts:219-225`): a new row kind after a reset never
  absorbs the next round's text.
- `stepLayout` already supports non-tool nodes (`thought`) and runs ended by any
  other row (`tool-steps.ts:113-187`); a fired wake shows the step-node-with-
  symbol shape (`StepNode` `node="wake"`, `ui/StepNode.tsx:56-57,372-380`).
- `Markdown.tsx` renders a parsed body (`TranscriptRow.tsx:393-411`, `parse` from
  `markdown.ts`), headings and ordered lists included (`markdown.ts:35-39`).
- §7 "logic in pure modules": every decision below lands in `transcript-history.ts`,
  `transcript.ts`, `tool-steps.ts` (pure, tested); the `.tsx` only draws a view.
- The TUI is untouched: `packages/tui` keeps its own `messagesToItems`; the
  shared `@tentacle/core` helpers are only READ.

### Design

1. **One new row kind** (`transcript-rows.ts`), replacing both the separator
   notice and the `restart` user row:
   ```ts
   export interface ContextRow {
     readonly kind: "context";
     readonly key: string;
     readonly event: "reset" | "compact";
     /** reset: the restart prompt; compact: the summary (content after the head). */
     readonly body: string;
     /** compact: `compactionSeparatorText(view)` minus `compacted` → "ctx 182k → 9k" | "". */
     readonly figures?: string;
     readonly at?: number; // the reset message's time (today on the restart row)
   }
   ```
   `Row` gains `| ContextRow`; `UserRow.restart` is REMOVED (and its
   `media-layout.ts:244` term). A new kind, not a `NoticeRow` flag: a notice is a
   harness line (`notice-group.ts:40`, `noticeLooks`, the lost-notice logic in
   `transcript.ts:420,768-801`), and this row must be a step node, not a line.
2. **History mapper** (`transcript-history.ts`): a restart message → ONE
   `context{event:"reset", body: restart, ...at}`; a summary message → one
   `context{event:"compact", body, figures}`; `compactionSeparatorRow` becomes
   `compactionRow(key, messages)` returning that row; `CONTEXT_RESET_SEPARATOR`
   is deleted. The summary body = content after `COMPACTION_SUMMARY_HEAD` with its
   leading blank line trimmed (the running-jobs / skills notes stay: they are
   part of what the model continues from — honest, never trimmed by guess).
   *(Q2 is drawing only; no mapper change.)*
3. **Fold** (`transcript.ts`): `applyHistory` for `compact` pushes
   `compactionRow` for ANY device, own included *(Q4-B: keep `own === true ?
   state`)*. `sameSlot` gets `case "context": b.kind === "context" && b.event ===
   a.event && b.body === a.body` (a resync keeps the key, so an open step stays
   open). `isRestartPrompt` stays (exported API) unchanged.
4. **Rail layout** (`tool-steps.ts`):
   - `StepCell` gains `{ kind: "context"; thread: ThreadPos }`; `stepLayout`
     treats a `context` row as a node of the current run, like a step: it
     flushes pending reasoning as an orphan Thought first (a thought belongs to
     the round before the reset) and is threaded with its neighbours *(Q1-B:
     the row ends the run on both sides — `flushOrphan(); endRun();` around a
     `LONE` cell)*.
   - **Q3-A:** a tool row `name === "context_reset"` with `status === "ok"`
     whose next non-hidden row is a `context{event:"reset"}` row → `HIDDEN`
     (the two are one fact). Running / error / denied, or an ok call with no
     reset row after it, stay ordinary steps. *(Q3-B: drop this rule.)*
   - `isThinking` treats a last row of kind `context` like `user` (the model
     starts a new round right after a reset: the "Thinking…" footer must show,
     as it does today with the restart user row last).
   - **`contextRowView(row, full)`** (pure, next to `thoughtRowView`):
     `{ node: "reset" | "compact", name: "Context reset" | "Compacted",
     subtitle, italic, body: { text, hidden } | null, tappable, a11yLabel }` —
     `subtitle` = the prompt's first non-blank line with markdown marks stripped
     (`**`, `` ` ``, leading `#`/`-`), or the figures; `body.text` = the first
     `CONTEXT_BODY_LINES = 12` source lines unless `full`, `hidden` = the rest
     (never cutting inside a ``` fence: the cut moves back to the fence start,
     or — if the fence opens on line 1 — past its end); `tappable` = body not
     blank; a11y = `Context reset. Restart prompt: <first line>` /
     `Compacted, context 182k to 9k` (spoken in words, never the arrow glyph).
     *(Q2-B: `full` forced true, no `hidden`.)*
5. **Drawing** (`ui/StepNode.tsx`, `screens/transcript/TranscriptRow.tsx`):
   `NodeKind` gains `"reset" | "compact"`, drawn as `Icon`
   `arrow.counterclockwise` / `arrow.down.right.and.arrow.up.left`, weight
   `light`, size of the wake glyph box, colour `palette.sec` on `palette.page`
   (the wake's look). A `ContextRowView` = `StepShell` + `StepNode` with
   `open`/`onToggle` from `StepProps` (screen state, not `useState` — survives
   recycling), body = `<Markdown parsed={…}>` tinted `palette.sec`, plus the
   existing show-all line when `hidden > 0` (`onShowAll`). The `restart prompt`
   caption and the `separator` branch for these rows go; the notice `separator`
   branch stays only if another producer remains (none after this change: the
   executor deletes it with its `NoticeRow.separator` field if `rg` confirms).
   Name in `palette.sec` (system fact, colour-blind: the SYMBOL and the word
   carry it). Parse the markdown only when open (memo by key + `full`).
6. **Kit:** `StepNode` styles change → `bun run mockup-kit` regenerates the kit
   (drift test). Not in this task: adding notice rows to the kit (reported gap).

### Files

Slice 1 — rows + mapper + fold (S–M, DeepSeek):
- `apps/mobile/src/transcript-rows.ts` — `ContextRow`, `Row` union, drop `UserRow.restart`.
- `apps/mobile/src/transcript-history.ts` — mapper + `compactionRow`; drop the separator constant.
- `apps/mobile/src/transcript.ts` — `applyHistory` (Q4), `sameSlot`.
- `apps/mobile/src/media-layout.ts` — drop the `restart` term.
- tests: `test/transcript.test.ts`, `test/transcript-reload.test.ts`,
  `test/row-times.test.ts`, `test/notice-row.test.ts`, `test/notice-group.test.ts`,
  `test/session-screen-commands.test.ts` (separator expectations → context rows).

Slice 2 — rail layout + view-model (S–M, DeepSeek):
- `apps/mobile/src/tool-steps.ts` — cell, `stepLayout` (node, Q3 hide, `isThinking`), `contextRowView`.
- `apps/mobile/test/tool-steps.test.ts`, `apps/mobile/test/step-rail.test.ts`.

Slice 3 — drawing (S–M, DeepSeek):
- `apps/mobile/src/ui/StepNode.tsx` — node kinds `reset`/`compact`.
- `apps/mobile/src/screens/transcript/TranscriptRow.tsx` — `ContextRowView`, dispatch, drop the restart caption (+ dead separator branch).
- (no `SessionScreen.tsx` change: every row already gets `open`/`full` by key, `SessionScreen.tsx:1866-1872`.)
- tests: `test/step-rail-render.test.ts` (the cell render).
- `tools/mockup-kit/generated/*` — regenerated by `bun run mockup-kit`.
- `changelog.d/mobile-reset-in-timeline.changed.md` — one bullet.

### Failure modes

- **A very long restart prompt or summary** (thousands of lines): collapsed it is
  ONE line (`numberOfLines={1}`); open shows 12 source lines + `show all`
  (Q2-A); the markdown is parsed only while open and memoised by key + `full`,
  so a closed step costs nothing per render. A fence cut at line 12 never
  renders a half code block (the cut rule above). One 10 000-char single line:
  the first-line subtitle is truncated by the Text, the body wraps — same as an
  assistant answer.
- **Empty / odd body:** a prompt that is only markup → the subtitle may be `""`
  (the name alone stands); a blank body → not tappable (never an empty
  expansion: `ui-empty-action-standard`). A prompt quoting `</restart_prompt>`:
  `lastIndexOf` already ends at the real close.
- **Several resets / compactions in one session:** each message → its own row,
  own key, own open state; consecutive events thread as consecutive nodes. Two
  resets with identical prompts are still two rows (keys from the fold's
  counter); `sameSlot` compares positionally, so a resync keeps both keys.
- **A reset while streaming:** the stream's `context_reset` lands between rounds
  (`agent.ts:2771-2791`): the previous assistant row is already closed, the
  context row becomes the last row, the next delta opens a NEW assistant row
  (`lastTextRow` only extends an assistant last row), and the "Thinking…" footer
  shows meanwhile (`isThinking` rule). Live reasoning pending before the reset
  flushes as an orphan `Thought` above the reset node. A cancel before the
  commit yields no `tool_result`/event: the running call ends as a normal
  cancelled step.
- **Live vs reopen:** live = `[…, context_reset(ok, hidden), ↺, skill steps…]`;
  reopen (the call discarded) = `[↺, skill steps…]` — the same visible nodes
  (Q3-A). Duplicate delivery (the stream event AND a `history{context_reset}`
  for the same reset) behaves exactly as today (both already append via
  `historyRows`); the executor adds a fold test pinning ONE context row per
  reset on the own-turn path and reports — not fixes — if a duplicate exists on
  `main` too.
- **Old sessions:** no format change — a stored restart message or summary from
  any older log maps to the new step; a legacy summary (head only, no
  `compacted`) shows `Compacted` with no figures. Nothing is written, so no
  version skew; an older app build keeps today's look.
- **Resync while a step is open:** `keepKeys` keeps the key (`sameSlot` case
  above) ⇒ the step stays open; a replace that changes the body mints a new key
  ⇒ it closes (honest: different content).
- **VoiceOver:** the node is one accessible element with the a11y label; the
  symbol is decorative.

### Tests

Red before green, per slice (§9), seams = the pure fold / mapper / layout (no
React), and one render test for the cell.

- *Mapper:* a restart message → exactly ONE `context{event:"reset"}` row whose
  `body` is the prompt and whose `at` is the message's time; NO `user` row and
  NO notice (red on `main`: today 2 rows). A summary with figures → one row,
  `figures: "ctx 182k → 9k"`, body = summary + notes, head excluded; a legacy
  summary → no figures.
- *Fold:* own compaction (`own: true`) → one context row (Q4-A; red today:
  `state` unchanged); a resync over the same history keeps the context row's
  key (`keepKeys`); a reset during a turn: rows `[…, tool ok, context]`, then a
  text delta opens a new assistant row (not appended to anything before).
- *Layout:* `context_reset` ok + following reset row ⇒ tool cell `hidden`;
  error / running / ok-without-reset ⇒ normal step (mutation check: remove the
  `ok` condition ⇒ the error test fails); context row is a node threaded with
  neighbours; a pending reasoning before it becomes an orphan `thought` cell;
  `isThinking` true with a context row last.
- *View-model:* subtitle strips markdown and takes the first non-blank line;
  12-line cap + `hidden`; a fence across line 12 is never cut; `full` shows
  all; blank body ⇒ not tappable; a11y wording.
- *Render:* `ContextRowView` closed ⇒ one line, no body; open ⇒ the markdown
  text present; `show all` present only with `hidden > 0`.
- *Parity:* `test/transcript-parity.test.ts` stays green (`restartPromptOf`
  unchanged); no TUI test changes (proves "mobile only").
- Gate per slice: the touched test files; at the end `bun run check` + the
  mobile e2e gate (`deterministic-test-gates`) and simulator screenshots of a
  session with a reset and a compaction, light + dark, before any iOS build.

## Execution

*— deepseek-v3.2 (executor), 2026-11-25 · **Slice 1 only***

**Load-bearing check, re-run before any edit** (branch tip `c33b9139`): `bun test
apps/mobile/test/{transcript,transcript-reload,row-times,notice-row}.test.ts` →
**83 pass / 0 fail**, and it pins exactly the old shape the plan cites (2 rows per
reset, a `separator` notice per compaction). The assumption holds; nothing was
blocked.

**As built, in the plan's order:**

1. `transcript-rows.ts` — `ContextRow` added as designed (`kind/key/event/body/
   figures?/at?`), `Row` gains `| ContextRow`, `UserRow.restart` removed. The
   `NoticeRow.separator` field went too: `rg` confirmed no producer left in the
   app (both producers became context rows), so it was dead — the plan's own
   condition ("the executor deletes it if `rg` confirms").
2. `transcript-history.ts` — the restart message maps to ONE `context{event:
   "reset", body: restart, ...at}`; the summary to `compactionRow(key, messages)`
   (`body` = content after `COMPACTION_SUMMARY_HEAD`, leading blanks trimmed; the
   running-jobs/skills notes kept), `figures` = `compactionSeparatorText` minus
   `compacted · `, absent for a legacy summary. `CONTEXT_RESET_SEPARATOR` deleted;
   `restartPromptOf` untouched (parity stays green).
3. `transcript.ts` — `applyHistory`'s `compact` branch pushes `compactionRow` for
   ANY device including `own` (Q4-A): the old `own === true ? state` term is gone.
   `sameSlot` gains the `context` arm (`event` + `body`). `isRestartPrompt`
   unchanged.
4. Tests: the six files the slice names, plus `media-layout.test.ts` (its
   `restart: true` case) and `transcript-parity.test.ts` (its `appShapes` mapping
   needed a `context` branch for the new union member).

**Drift from the Implementation, and why:**

- **Two Slice-3 edits came forward, forced by the compiler.** `UserRow.restart`
  is used by `TranscriptRow.tsx`'s caption (`:367-369`) and by
  `media-layout.ts:244`; removing the field makes both fail to typecheck, so Slice
  1 cannot be green without them. They are exactly the two deletions Slice 3
  lists ("the `restart prompt` caption and its `media-layout.ts:244` term"), no
  more: the `ContextRowView`, the `NodeKind`s and the show-all body all stay in
  Slice 3. The now-dead `separator` branch (`TranscriptRow.tsx:884-901`) and
  `styles.rule` went with the field, since nothing could reach them.
- **`transcript-parity.test.ts` is not in the slice's file list** but its
  `appShapes` switch is exhaustive over `Row`: the new union member needed an arm
  (`context` → a kind/text shape). No fixture exercises a reset or a compaction,
  so behaviour is unchanged; the arm only keeps the test compiling honestly.
- **A duplicate-delivery finding, reported not fixed** (as the plan asks): on
  `main` today, a `context_reset` stream event AND the follow-up
  `history{reason:"context_reset"}` of the SAME reset both append via
  `historyRows`, so the phone shows TWO rows. I pinned that in
  `"a reset delivered TWICE shows TWO steps (main's behaviour, reported not
  fixed)"` (`toHaveLength(2)`), which asserts the real behaviour rather than a
  wish — the plan says report, not fix, and `session-feed.ts` raises both from one
  client activity. Pre-existing on `main`; it belongs to a follow-up task.

**Mutations (each reverted immediately; the failing assertion named):**

- `applyHistory` back to `own === true ? state` → `this client's OWN compaction
  leaves the step too (Q4-A)` FAILS. (Proves the Q4-A term is load-bearing.)
- `sameSlot`'s `context` arm removed → after adding the changed-body case,
  `a resync keeps the context step's KEY` FAILS. **The first version of that test
  was vacuous** (`default` also matched by kind, so it passed with the arm gone);
  the discriminating half — a CHANGED body must mint a new key — was added while
  the mutation was in place, then it went red. This is the §9 non-vacuity check
  earning its keep.
- `figures` forced to `""` → 4 failures across `transcript-reload`'s four
  compaction tests (reopen, body-without-head, legacy, live-other-device).
- `...at` dropped from the reset row → `the reset step keeps the reset message's
  time` (`row-times`) FAILS.
- `compactionOf(m) !== null` guarded by `restart !== null` → the 3 reopen-side
  summary tests FAIL.

**Gate:** the slice's own files only, as instructed — 159 pass / 0 fail across the
8 touched test files; `bunx tsc -p apps/mobile --noEmit` clean; `bunx biome check`
clean on all 13 changed files. The full `bun run check` is the orchestrator's.
No `packages/protocol` file was touched, so `protocol.json` needs no
regeneration. Changelog: `changelog.d/mobile-reset-in-timeline.changed.md`
(one bullet). `TODO.md` untouched.

### Slice 2 — rail layout + view-model

*— claude-opus (claude-code 2.1.325, model `opus`), 2026-11-25*

**Load-bearing check, re-run before any edit** (branch tip `f461275e`, Slice 1 in):
`bun test apps/mobile/test/{tool-steps,step-rail,transcript-cell}.test.ts` →
**37 pass / 0 fail**. The assumption holds: a `context` row exists in the `Row`
union (`transcript-rows.ts:243-262`), reaches the layout through `stepLayout`, and
today the layout **ignores** it (`tool-steps.ts` only branches on `reasoning`,
`tool`, and the rest; `sameStepCell` has no `context` arm) — so the residue of
Slice 1 is exactly the gap this slice fills.

**As built, in the plan's order (`apps/mobile/src/tool-steps.ts`):**

1. `StepCell` gains `{ kind: "context"; thread: ThreadPos }`; `Node` gains a
   `context` member.
2. `stepLayout` treats a `context` row as a node of the current run: it flushes
   pending reasoning as an orphan `Thought` (a thought belongs to the round the
   reset ENDED) and joins the thread like a step.
3. Q3-A merge: `mergedResetCalls` finds every `context_reset` tool row with
   `status === "ok"` whose next NON-reasoning row is a `context{event:"reset"}`
   and hides it (`HIDDEN`); a running/error/denied/queued call, an ok call with
   no reset row after it, and an ok call followed by a COMPACTION row stay
   ordinary steps. A merged call is transparent to the thread (it neither ends
   the run nor opens a batch), like a folded reasoning row.
4. `isThinking` treats a last row of kind `context` like `user`.
5. `contextRowView(row, full)` + `CONTEXT_BODY_LINES = 12`, next to
   `thoughtRowView`: `{ node, name, subtitle, italic, body, tappable, a11yLabel }`
   — subtitle = the prompt's first non-blank line with markdown marks stripped
   (headings, list bullets, quotes, code, bold/italic/strike, links) or the
   figures; `italic` true only for a reset's prose line; body = the first 12
   source lines (`safeCut`: never inside a ``` fence — back to the fence's
   opening line, or past its close when that opening IS line 1) unless `full`;
   blank body ⇒ `body: null`, `tappable: false`; a11y = `Context reset. Restart
   prompt: <line>` / `Compacted, context 182k to about 9k` (the `→` spoken).

**Drift from the Implementation, and why:**

- **`transcript-cell.ts` gained a `context` arm** — a file Slice 2's list does not
  name. `sameStepCell` is an exhaustive switch over `StepCell`; the new member
  left it returning `undefined`, which only shows up at runtime (typecheck is
  happy, `noImplicitReturns` counts the pre-existing `switch` as returning). Its
  test is `test/transcript-cell.test.ts`, also not in the slice's list — both
  added with a red-before-green case. Same category of drift Slice 1 reported for
  `media-layout.ts`/`transcript-parity.test.ts`: the compiler (or, here, the
  contract) forces one line outside the named files.
- **`test/tool-steps.test.ts` also carries the view-model tests.** The slice
  names `tool-steps.test.ts` + `step-rail.test.ts`; `step-rail.test.ts` is
  `step-rail.ts`'s GEOMETRY (the branch to a `$` line) and has nothing to do with
  this slice — untouched and still green. `contextRowView` is tested in
  `tool-steps.test.ts`, beside `stepRowView`/`thoughtRowView`.
- **The view-model's `italic` is a boolean, not the plan's bare field** — the
  plan writes `italic` without saying what it qualifies; it is "the subtitle is
  the prompt's own prose", so a compaction's mono figures are not italic.
- **No `figures` parsing in `contextRowView`:** absent ⇒ `subtitle: ""` and a11y
  `Compacted` (a legacy summary), exactly as the mapper leaves it.

**Mutations (each reverted immediately; the failing assertion named):**

- `status !== "ok"` dropped from `mergedResetCalls` → `an error / denied /
  running call stays an ordinary step (no reset happened)` FAILS.
- The whole `context` branch dropped from `stepLayout`'s loop → 5 failures (all
  four rail tests + the merge test that needs `c1` threaded).
- `last.kind === "context"` dropped from `isThinking` → `the tail shows with a
  context row last` FAILS.
- `safeCut(lines)` → the fixed `CONTEXT_BODY_LINES` → both fence tests FAIL.
- The list-bullet strip dropped from `stripMarks` → initially **no test failed**;
  the case (`- **Carry** on` / `1. Carry on` / `> Carry on`, and the body
  keeping its markdown) was written WHILE the mutation was in place, went red,
  then green on the revert. The §9 non-vacuity check earning its keep again.
- `transcript-cell.ts`'s `context` arm returning `true` unconditionally →
  `a context cell compares its thread` FAILS.
- A merged call ending the run (`endRun()` instead of nothing) → `ok + the reset
  row right after it` FAILS. While fixing that test's thread expectation it
  first asserted the WRONG shape (an orphan thought as a run of its own), which
  the correct code rejected — the assertion was corrected from a real
  observation, not bent to pass.

**Gate:** the slice's own + adjacent files — 219 pass / 0 fail across the 12
mobile test files that import `tool-steps.ts`/`transcript-cell.ts` or build
`context` rows, plus 89/0 across the render-level transcript tests;
`bunx tsc -p apps/mobile --noEmit` clean; `bunx biome check` clean on all 4
changed files. The full `bun run check` is the orchestrator's. No
`packages/protocol` file was touched. Changelog fragment already exists from
Slice 1 (`changelog.d/mobile-reset-in-timeline.changed.md`) and this slice adds
nothing user-visible on its own (Slice 3 draws it), so it is unchanged.
`TODO.md` untouched. **Unverified:** the on-device look (the simulator screenshots
the plan's Gate asks for) — Slice 3 draws the node; nothing renders
`contextRowView` yet.

### Slice 3 — drawing

*— claude-code 2.1.325 (this agent's model id is not exposed to it; Slice 2 ran on
the same binary, model `opus`), 2026-11-25*

**Load-bearing check, re-run before any edit** (branch tip `c267d857`, Slices 1–2
in): `bun test apps/mobile/test/{tool-steps,step-rail-render}.test.ts` →
**51 pass / 0 fail**, and the gap is exactly this slice: `contextRowView` exists
and is tested (`tool-steps.ts:604`), the `context` row reaches
`TranscriptRow`, but `TranscriptRow`'s `switch` has **no `context` arm** (it falls
to `default: return null`), so a context step draws NOTHING — and `NodeKind` has
no `reset`/`compact` (the new render test was red on exactly that: 6 fail, then
0).

**As built, in the plan's order:**

1. `apps/mobile/src/ui/StepNode.tsx` — `NodeKind` gains `"reset" | "compact"`;
   `Node` draws one `case` for both through the ONE icon seam (`Icon.tsx`, the
   plan's `arrow.counterclockwise` / `arrow.down.right.and.arrow.up.left`),
   `weight="light"`, in a new `styles.contextNode` box (`CONTEXT_NODE_SIZE = 14`,
   the `◷` wake glyph's box) on `palette.page` so it masks the rail, in
   `palette.sec`. The NAME was already `sec` (`StepNode.tsx:545`), so the system
   fact is carried by symbol + word, never hue alone.
2. `apps/mobile/src/screens/transcript/TranscriptRow.tsx` — `ContextRowView`
   (a dumb renderer over `contextRowView`: `StepShell` + `StepNode`, `open`/
   `full`/`onToggle`/`onShowAll` all from `StepProps`, i.e. screen state, never
   `useState`), the `case "context"` arm, the open body = `<Markdown>` of the
   view's cut with a `sec`-tinted palette (`secTinted`), the show-all line when
   `body.hidden > 0`, and two styles (`contextBody`, `contextMore`). The restart
   caption and its `separator` branch were already gone (Slice 1's forced carry).
3. Tests: `apps/mobile/test/context-row-render.test.ts` (new, the cell render,
   `notice-row.test.ts`'s host-stub walker) + one source-pin case in
   `test/step-rail-render.test.ts` for the glyph's box (the file imports React
   Native, so the node's look is pinned as SOURCE — that file's own pattern).
4. `bun run mockup-kit` regenerated `tools/mockup-kit/generated/*` (StepNode and
   TranscriptRow styles changed): `kit-data.json` + `tokens.css`, 3 files written,
   drift test green.

**Drift from the Implementation, and why:**

- **The cell-render test is a NEW file, `test/context-row-render.test.ts`**, not
  the plan's `test/step-rail-render.test.ts`. That file pins StepNode's drawing
  as SOURCE (it imports React Native, so it has no walker); a real
  walk-and-assert of a row's tree needs `notice-row.test.ts`'s host-stub +
  `mock.module` harness, which is ~110 lines of setup. Splitting keeps one file
  per job — the walker in the new file, the glyph's look as a source pin added to
  `step-rail-render.test.ts` (its own pattern, one `describe`).
- **`apps/mobile/src/ui/Icon.tsx` gained the two `IconName`s** — a file the slice
  does not name. `StepNode` cannot pass an SF Symbol name without it
  (`Icon.tsx`'s `IconName` is a closed union; `tsc -p apps/mobile` failed with
  `TS2322: "arrow.counterclockwise" is not assignable to type 'IconName'`). Same
  compiler-forced one-site carry the earlier slices reported.
- **The open body lives inside `StepNode`'s `body` slot**, not as a sibling: that
  is what the node already does for a tool's `StepBody` (`open && body !==
  undefined`), so the reset step gets the same open/closed animation, the same
  `borderTopColor: sepChat` rule and the same "no body while closed" property for
  free — the plan says "`StepShell` + `StepNode` ... body = `<Markdown parsed>`",
  which this realises at the node's own seam.
- **The show-all line is a `Pressable` calling `step.onShowAll`** (the plan names
  `onShowAll`); a bare `<Text>`, the first version, would have shown an offer
  nothing could accept. Its label is the plan's wording, and it is `disabled`
  without `StepProps` (a row drawn alone never offers a dead tap).
- **The a11y figures wording is Slice 2's**, not the plan's sample: the plan's
  `Compacted, context 182k to about 9k` assumed a `~` figure; Slice 2's
  `spokenFigures` adds "about" only when the figures carry a `~`
  (`tool-steps.ts:718-726`), and the fixture figure (`ctx 182k → 9k`) is exact.
  The test asserts the code's real wording, and Slice 2's own test already pins
  the `~` case. The plan's line was an illustration, not a second rule.
- **Three test-helper bugs of my own, fixed while going red**: the walker must
  STOP at `StepNode` (it runs hooks — an invalid-hook crash otherwise), it NESTS
  children (so a flat `all()` found nothing below the first `View`), and
  `bodyText` must walk the body's own tree. Recorded because the first version of
  the test failed for these reasons, not for the feature's.

**Mutations (each reverted immediately; the failing assertion named):**

- `body === null || step?.open !== true` → `body === null` (body drawn while
  closed) → 2 failures, `the node, the name ... a11y label` and `no StepProps ...
  still a lone, closed step` (both assert `props.body` is undefined).
- `palette={secTinted(palette)}` → `palette={palette}` → `the body is the parsed
  markdown of the prompt, tinted sec` FAILS.
- `onPress={step?.onShowAll}` → `onPress={undefined}` → `nothing held back = no
  show-all line; a cut body offers it` FAILS.
- `const full = step?.full ?? false` → `const full = false` → the same test
  FAILS (a `full` body would still draw "tap to see all").
- `cell?.kind === "context" ? cell.thread : LONE` → `LONE` → `the node, the name
  ...` FAILS on the thread.
- `view.tappable && step !== undefined` → `step !== undefined` → `a blank body is
  never an empty expansion` FAILS (an empty body became tappable).
- The `case "context"` arm removed → all 6 render tests FAIL (the row draws
  nothing — the pre-slice behaviour, so this is the red state itself).
- `StepNode`: `kind === "reset" ? … : …` → one symbol for both → the
  `step-rail-render` source pin FAILS.
- **Not mutation-checked:** `Icon.tsx`'s union (its only failure mode is a
  typecheck error, which is what forced the edit) and the kit regeneration (the
  drift test in `scripts/test/mockup-kit.test.ts` is the check: 50 pass / 0 fail
  over the two kit files).

**Gate:** the slice's own + adjacent files, as instructed — 278 pass / 0 fail
across the 18 mobile test files that render or fold a row; 50 pass / 0 fail for
the two kit test files; `bunx tsc -p apps/mobile --noEmit` clean; `bunx biome
check` clean on all 5 changed source/test files (kit data is generated). The full
`bun run check` is the orchestrator's. No `packages/protocol` file was touched, so
`protocol.json` needs no regeneration. Changelog: the Slice-1 fragment
`changelog.d/mobile-reset-in-timeline.changed.md` still describes exactly this
outcome (it names the `↺ Context reset` / `⤡ Compacted` nodes, which now actually
draw), so it is unchanged rather than duplicated. `TODO.md` untouched.

**Unverified:** the on-device look — the plan's Gate asks for simulator
screenshots (a session with a reset and a compaction, light + dark) before any
iOS build, and this agent has no simulator. Verify by running the app on a
session that reset its context: `↺ Context reset` + the prompt's first line in
italic `sec`, tap → the prompt as markdown, capped at 12 lines with `… N more
lines · tap to see all`; a compaction draws `⤡ Compacted` + `ctx A → B`.



### Gate fixes after Execution (2 failures)

The orchestrator's gate failed on two tests, neither in this task's own code.
Both are fixed here.

1. **`scripts/test/mockup-kit.test.ts > drift … > no drift`** — real, and ours.
   Slice 3 edited `apps/mobile/src/screens/transcript/TranscriptRow.tsx` but did
   not regenerate the kit, so the committed
   `tools/mockup-kit/generated/kit-data.json` still carried the OLD content hash
   for that file (`e032760d…` ≠ `9b699f60…`). Fixed with `bun run mockup-kit`:
   the only change in the regenerated output is that one hash — no style value,
   token or kit row moved, so Slice 3's "the kit is unaffected" claim holds.
   Evidence: the drift test was red before (it names the file, both hashes and
   the fix), green after (`37 pass / 0 fail`); the diff is one line.
2. **`packages/cli/test/serve-mcp.test.ts > T12`** — a pre-existing flake in
   `packages/cli`, not caused by this branch (it touches no file under
   `packages/cli`), but the gate stays red until it is fixed. It sampled
   `pidAlive(firstPid)` ONCE right after the crashing turn settled. The child's
   death and its REAPING are two separate events: the transport settles the turn
   on the pipe close, and at that instant the pid is still a **zombie** — probed
   directly (`.tentacle/tmp/mobile-reset-in-timeline/probe5.ts`, 25/25 runs):
   `kill(pid, 0)` answers `true` while `ps -o stat=` says `ZN`, becoming empty
   only once the parent reaps it. A single sample is a race, not a sync point
   (AGENTS §9). Replaced with `await until(() => !pidAlive(firstPid), 20_000)`,
   which polls the very condition the next assertions read.
   Non-vacuity (§9): mutating the fixture knob (`MCP_CRASH_ON_CALL_ONCE: "1"` →
   `"0"`, so the server never crashes) makes the poll time out and T12 fail;
   reverted → green. That ~1 ms window is also why 10 parallel runs and 14× CPU
   pressure did not reproduce it — unloaded, the reaping usually wins.

Both fixes are test/artifact-only: no production code changed.

**Gate (this agent, as instructed):** `packages/cli/test/serve-mcp.test.ts`
9 pass / 0 fail; `scripts/test/mockup-kit.test.ts` 37 pass / 0 fail;
`bunx biome check packages/cli/test/serve-mcp.test.ts
tools/mockup-kit/generated/kit-data.json` clean. The full `bun run check` is the
orchestrator's.

## Review

*— claude-opus-5-5, 2026-11-25* (fresh context; scope `git diff main...HEAD`, Slices 1–3)

**Verdict: APPROVE-WITH-NITS** — no HIGH/MEDIUM finding.

**Gate (this reviewer):** the 14 touched test files (12 mobile + `packages/cli/test/serve-mcp.test.ts`
+ `scripts/test/mockup-kit.test.ts`) → **270 pass / 0 fail**; `bun run lint` clean
(2423 files); `bun run typecheck` clean (root + mobile + relay). Full `bun run test`
not re-run here (the orchestrator's merge gate).

**Mutation non-vacuity (each reverted; `git status` empty afterwards):**
- `mergedResetCalls` drops `next.event === "reset"` (a compaction would swallow the
  call) → `a compaction row after the call does not merge it` FAILS.
- `safeCut` `opening > 0` → `>= 0` → `a fence opened on line 1 is cut past its close` FAILS.
- `compactionRow` body = whole content (head kept) → 2 `transcript-reload` compaction tests FAIL.

**End-to-end trace** (`.tentacle/tmp/mobile-reset-in-timeline/trace-review.ts`, real
`apply` + `stepLayout`): `turn_started → tool_call/tool_result context_reset (ok) →
context_reset event` ⇒ rows `[tool:ok, context:reset]`, cells `{tool: hidden, context:
node}` — Q3-A live = reopen holds. A `history{compact}` ⇒ one `context` row, body without
the head.

**Premise table (deltas only):**
- FALSE (harmless): Context's "THIS phone's successful `/compact` leaves no transcript
  row" via `own === true ? state`. No producer ever sets `own: true` (`git grep` on
  `main`: none in `apps/mobile/src` or `packages/client/src`; `session-feed.ts:314-327`
  forwards `reason` only), so `main` already drew the separator for an own compaction.
  Q4-A's outcome is unchanged; the removed term was dead, and the Q4-A mutation test
  pins only the fold, not a real path.
- TRUE: one `historyRows` path for all deliveries; `sameSlot` positional + new arm;
  `lastTextRow` only extends an assistant row (pinned by the mid-turn test).

**Attacks tried:**
1. §7 "logic in pure modules": every decision (merge, cut, subtitle, a11y, thread) is in
   `tool-steps.ts`/`transcript-history.ts`; `ContextRowView` only maps the view. Holds.
2. §7 protocol/persistence: no `packages/protocol`, daemon or TUI file touched; nothing
   persisted. Holds (blast `contained` is accurate).
3. Open/full state survives recycling: `TranscriptCell` passes `open`/`full`/`onShowAll`
   by key for every row (`SessionScreen.tsx:1866-1872`, `TranscriptCell.tsx:61-68`);
   `sameStepCell` gained the `context` arm. Holds.
4. Q3-A false merges: compaction after the call, error/denied/running calls stay steps
   (tests + mutation above). Holds.
5. Fence-cut / blank body / legacy summary: pinned by tests; blank ⇒ not tappable. Holds.

**Nits (not blocking):**
- N1 `tool-steps.ts:718-726` `spokenFigures` only matches `NNk → ~NNk`; `formatTokens`
  also yields `M` and sub-1k figures, so `ctx 1.3M → ~40k` is spoken raw — arrow glyph
  and `~` — against the plan's "never the arrow glyph" (trace output above). Widen the
  regex to `\d+(?:\.\d+)?[kM]?`.
- N2 Unlisted behaviour shifts from removing the restart `user` row: Retry's
  `lastUserRow` (`session-screen-controller.ts:1146`) now re-sends the person's pre-reset
  prompt instead of the restart prompt, and the per-turn scans `hasAnswerText` /
  `noticeSeenThisTurn` (`transcript.ts:758-768`) now span the whole turn across a reset.
  Arguably more correct; not in Failure modes — worth one line there.
- N3 `parsedOf` (`TranscriptRow.tsx:174`) is not memoised by key + `full` as the plan
  says; mitigated by `TranscriptCell`'s data `memo` (re-parse only when the row's props
  change). Plan wording, not a defect.

**Not verified:** on-device look (simulator screenshots, light + dark) and the mobile e2e
gate — no simulator here.

**Executor behaviour:** drift was reported honestly and each carry (`media-layout.ts`,
`Icon.tsx`, `transcript-cell.ts`, parity arm) was compiler- or contract-forced; vacuous
first-draft tests were caught by its own mutations and fixed. The duplicate-delivery
case was pinned as "report, not fix" as instructed. **Same-family caveat:** Slices 2–3
ran on an Opus build; this review is Opus too — only the context is fresh.
