# feat/mobile-reset-in-timeline — Context reset and compaction as timeline steps (iPhone)

> **Status:** implementation — **NOT approved** (4 owner questions open, below)
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

## Implementation

*— claude-opus-5-5, 2026-11-25*

**NOT approved** — written for the recommended answers (1A 2A 3A 4A); each other
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

*— (empty until the plan is approved)*

## Review

*— (empty)*
