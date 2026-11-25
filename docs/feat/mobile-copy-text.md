# feat/mobile-copy-text — Copy a message (whole or a part) on the phone

> **Status:** APPROVED (owner answer Q1 = A, 2026-11-25)
> **Branch:** `feat/mobile-copy-text`
> **Type:** feat · **Size:** M · **Blast:** contained · **Suited:** DeepSeek executes; standard in-context Review + Simulator check (below)
> **Changelog:** `changelog.d/mobile-copy-text.added.md` — `- **Copy a message on the phone.** Long-press a message to copy it whole (a light haptic and a "Copied" confirmation); "Select text" opens it in a sheet where any part can be selected and copied.`

## Context

*— claude-opus-5-5, 2026-11-21*

Owner (2026-11-20, TODO row `feat/mobile-copy-text`): on the phone, copy
conversation text. Today only the chat header's "…" menu copies, and only
"Copy last answer" / "Copy conversation" (`apps/mobile/src/session-menu.ts:47-55`,
copied at `SessionScreen.tsx:1760`). **Binding owner choice: BOTH**
(1) long-press a message → light haptic + copy the WHOLE message + a "Copied"
confirmation, and (2) selectable message text to copy a PART. The logic
(what a row copies) lives in a pure module (AGENTS §7); it must behave the
same for a Mac (laptop) session and a `serve` session.

**Repro** (2026-11-21, `.tentacle/tmp/mobile-copy-text/probe.sh`, run against
this branch = `main` b875a12d; RN from the main checkout's `node_modules`):

```sh
#!/bin/sh
W=/Users/gmeghnag/tentacle/.tentacle/worktrees/mobile-copy-text/apps/mobile
RN=/Users/gmeghnag/tentacle/apps/mobile/node_modules/react-native
echo "== onLongPress / Clipboard in transcript rows =="; grep -c "onLongPress\|Clipboard" $W/src/screens/transcript/TranscriptRow.tsx
echo "== selectable in transcript =="; grep -n "selectable" $W/src/screens/transcript/*.tsx
echo "== RN version =="; grep '"version"' $RN/package.json
F=$RN/React/Fabric/Mounting/ComponentViews/Text/RCTParagraphComponentView.mm
echo "== selectable => long-press recognizer + copy of FULL range =="; grep -n "addGestureRecognizer:_longPressGestureRecognizer\|NSMakeRange(0, attributedText.length)\|action == @selector(copy:)" $F
echo "== RCTUITextView never overrides selectable =="; grep -c "selectable" $RN/Libraries/Text/TextInput/Multiline/RCTUITextView.mm
echo "== Markdown: one <Text> per block, lists/quotes/code are Views =="; grep -n "<View key={id}\|<CodeBlock\|<Text key={id} style={\[styles.paragraph" $W/src/screens/transcript/Markdown.tsx
```

```
== onLongPress / Clipboard in transcript rows ==
0
== selectable in transcript ==
…/TranscriptRow.tsx:458:          <Text selectable style={[typography.body, styles.firedBody, { color: palette.sec }]}>
== RN version ==
  "version": "0.88.0",
== selectable => long-press recognizer + copy of FULL range ==
344:  [self addGestureRecognizer:_longPressGestureRecognizer];
386:  if (paragraphProps.isSelectable && action == @selector(copy:)) {
399:  NSData *rtf = [attributedText dataFromRange:NSMakeRange(0, attributedText.length)
== RCTUITextView never overrides selectable ==
0
== Markdown: one <Text> per block, lists/quotes/code are Views ==
112:    <CodeBlock
193:          <Text key={id} style={[styles.paragraph, { color: ctx.palette.label }]}>
213:        return <View key={id} style={[styles.rule, …
216:          <View key={id} style={[styles.quote, …
222:          <View key={id} style={styles.list}>
248:        return <View key={id} />;
```

Read: no message row copies today (0 hits; the only `selectable` is a fired
wake's body). And `selectable` on iOS is NOT partial selection — see below.

## Implementation

*— claude-opus-5-5, 2026-11-21*

### Load-bearing assumption

**On iOS (RN 0.88, Fabric — the only architecture), `<Text selectable>` cannot
give "copy a part", and it collides with a row long-press.** Proven from the
native source (`react-native/React/Fabric/Mounting/ComponentViews/Text/RCTParagraphComponentView.mm`):

- `selectable` adds a native `UILongPressGestureRecognizer` to the paragraph
  view (`:337-344`, wired on the prop at `:125-127`) whose handler presents the
  edit menu (`:357-375`) — the SAME gesture a JS `Pressable onLongPress` waits
  for, so on a long-press the native recognizer and the JS responder race
  (the native one's touch-cancel typically aborts the JS long-press; either
  way the person gets the wrong one or both).
- The only action it allows is `copy:` (`:386`), and `copy:` copies the
  **whole** attributed string, `NSMakeRange(0, attributedText.length)`
  (`:393-410`). There are no selection handles: "select a part" does not exist.
- Its scope is one native paragraph = one root `<Text>` and its nested
  `<Text>` spans. Our markdown draws **one root `<Text>` per block**
  (`Markdown.tsx:193`), and lists, quotes, rules, tables and code blocks are
  `View`s / `ScrollView`s / `CodeBlock` (`Markdown.tsx:112,130-162,213-236`).
  So `selectable` on a markdown row would copy ONE paragraph, never a list
  item's neighbour, never across blocks, never the code.

What DOES give native partial selection on iOS: a **read-only multiline
`TextInput`** — RN sets only `editable` on the backing `UITextView`
(`RCTTextInputComponentView.mm:215-216`) and `RCTUITextView.mm` never touches
`selectable` (0 hits), so UIKit's default `selectable = YES` stands: handles,
double-tap word, the Copy/Look Up/Share menu.

Honest design that follows: **long-press = copy whole (owner's (1)), and
"part" = an explicit "Select text" action that opens the message's text in a
sheet whose body is a read-only `TextInput` (owner's (2)).** No `selectable`
on transcript rows. The native "Copy" menu with an added "Copy message" item is
rejected: RN exposes no API to add items to the paragraph's edit menu, and its
Copy is per-paragraph anyway. Simulator check S2/S6 confirms this on device.

### Preconditions

- One row model for every runtime: the transcript is `Row[]`
  (`transcript-rows.ts:197`), drawn by `TranscriptCell` → `TranscriptRow`
  (`TranscriptCell.tsx:52-53`) whether the session lives on the Mac or on a
  `serve` daemon; copying reads only the row, on the phone, with no RPC. So
  Mac and serve behave identically by construction (pinned by a test, T6).
- Clipboard seam already used: `expo-clipboard` `setStringAsync`
  (`SessionScreen.tsx:21,1760`; `ui/CodeBlock.tsx:66`). Haptics through
  `playHaptic` (`haptics.ts:9`), kinds in `haptic-rules.ts:14` (`"light"` exists).
- Text a menu copy uses today: the raw `row.text` of `user`/`assistant` rows
  with non-blank text (`session-menu.ts:22-29,47`) — i.e. the **markdown
  source**. A per-message copy must agree with "Copy last answer" (same row →
  same bytes), so the rule is shared, not duplicated.
- A fired scheduled wake is a `user` row drawn as a timeline node, not a bubble
  (`TranscriptRow.tsx:938-944`, `schedule-view.ts:119`), and its body is
  already `selectable` (`:458`).
- The row swipe is move-only (`SwipeTime.tsx:9-12`): a stationary long-press
  never grants it, so the two gestures do not collide.
- Empty-action owner standard: an action with nothing to give plays a light
  haptic and says why inline, never opens an empty sheet
  (`docs/feat/mobile-hub-commands.md:16`, `mobile-hub-tools.md:249`).
- Owner is colour-blind: state is carried by glyph + word, never by colour
  alone (`transcript-rows.ts:166-170`).

### Design

**D1 — pure module `src/message-copy.ts` (React-free, unit-tested).**

```ts
/** The text a message row copies: user/assistant only, markdown source, trailing blanks trimmed; else null. */
export function messageText(row: Row): string | null;

export type MessageCopy =
  | { readonly kind: "copy"; readonly text: string; readonly label: "Copied" }
  | { readonly kind: "empty"; readonly label: "No text to copy" };

/** What a long-press on `row` does; null = the row has no long-press (tool, thought, notice, fired wake). */
export function messageCopy(row: Row, now: number): MessageCopy | null;

/** The confirmation pill's window, half-open like hub-flash (`now - at < COPY_FLASH_MS`). */
export const COPY_FLASH_MS = 2500;
export function copyFlashShown(flash: { readonly at: number } | null, now: number): boolean;
```

Rules (each a test):
- `assistant` → `row.text.trimEnd()` (markdown source: code fences, links as
  `[t](url)`, tables as pipes — pasting into Notes/Slack/an editor keeps the
  structure, and it equals "Copy last answer").
- `user` (ordinary bubble) → its text. `restart` prompt → its text.
  Photos and `[pdf: …]` lines are NOT text: a photo-/file-only message →
  `empty`. (Copying `[image: x.jpg]` would paste a label, not the photo.)
- `user` that `firedRowView(text, schedule, now)` turns into a wake node → `null`
  (it keeps its existing `selectable` prompt; no double gesture).
- `tool`, `reasoning`, `notice` → `null` (out of scope; a code block keeps its
  own copy button, a tool's output is not a "message").
- Blank text after trim → `empty` (never a `copy` of `""`).
- `session-menu.ts` `said()` switches to `messageText` (same bytes; its own
  tests stay green — refactor, no behaviour change; fired prompts stay in
  "Copy conversation" as today since `said` does not apply the fired rule).

**D2 — the long-press (dumb wiring).** `UserRowView`'s bubble and
`AssistantRowView`'s `Shell` are wrapped in a `Pressable`
(`onLongPress`, `delayLongPress={400}`, no `onPress`, `testID="row-<key>-copy"`,
`accessibilityActions=[{name:"copy", label:"Copy message"}]` + `onAccessibilityAction`
so VoiceOver can reach it). `RowProps` gains
`onCopy?: (row: Row) => void`; absent = no wrapper (tests, Activity sheet).
Nested `Pressable`s keep their own taps (speak, links, code copy, photo tiles).
The screen's handler (`SessionScreen`, next to the menu copy) does:
`const v = messageCopy(row, Date.now())` → `playHaptic("light")` in BOTH
branches (owner: light) → on `copy`: `Clipboard.setStringAsync(v.text)` then
show the pill; on `empty`: show the pill with the reason. A clipboard failure
shows "Couldn't copy" (no silent drop).

**D3 — the confirmation pill** (`src/ui/CopyFlash.tsx`, render only): a
floating capsule above the composer, absolutely positioned (no layout change,
so `follow.ts` `contentGrew` never fires and the list never jumps):
`✓ Copied · Select text` (copy) or `No text to copy` dimmed (empty, no action).
Glyph + word (colour-blind safe; the ✓ uses `palette.label`, not green-only).
`copyFlashShown` decides visibility; the screen owns one timer. A second
long-press replaces the flash (new `at`, new row).

**D4 — "Select text" sheet** (`src/screens/SelectTextSheet.tsx`, render only,
reusing `ui/Sheet.tsx` with `onClose`): title "Select text", body a
`TextInput` `value={text}` `editable={false}` `multiline` `scrollEnabled`
(body font, `palette.label`), plus a "Copy all" pill that runs the same copy
path. It shows the SAME `messageText` string the long-press copied, so
"what you select is what you paste". Opened only from the pill (Variant A).

### Files

1. `apps/mobile/src/message-copy.ts` (new) + `apps/mobile/test/message-copy.test.ts` (new).
2. `apps/mobile/src/session-menu.ts` — `said()` uses `messageText`.
3. `apps/mobile/src/ui/CopyFlash.tsx` (new), `apps/mobile/src/screens/SelectTextSheet.tsx` (new).
4. `apps/mobile/src/screens/transcript/TranscriptRow.tsx` — `onCopy` prop, the two wrappers.
5. `apps/mobile/src/screens/transcript/TranscriptCell.tsx` — pass `onCopy` through.
6. `apps/mobile/src/screens/SessionScreen.tsx` — handler, flash state + timer, sheet state.
7. `apps/mobile/test/message-copy-render.test.ts` (new; the `artifact-card-render.test.ts` element-walk pattern).
8. `apps/mobile/e2e/flows/` — one Maestro step in the UI flow (long-press `row-…-copy`, assert "Copied"), if the gate's flow allows long-press (`longPressOn`).
9. `changelog.d/mobile-copy-text.added.md`.

No protocol, daemon, client or persistence change.

### Failure modes

| Case | Convergence |
|---|---|
| Long-press during scroll | The list takes the responder; Pressable cancels; nothing copied, no haptic. |
| Long-press on a link / code-copy / speak / photo | The inner pressable owns the touch; no message copy (documented, S4). |
| Long-press inside a code block's sideways scroller | Bubbles to the row: copies the WHOLE message (S5). |
| Row still streaming | Copies the text on screen at that moment (a snapshot); the pill says "Copied". Re-long-press later for the rest. |
| Photo/file-only or blank message | `empty`: light haptic + "No text to copy" pill, nothing written to the clipboard. |
| Fired wake, tool, thought, notice | No wrapper (`null`): no haptic, no pill — not an action. |
| Clipboard write rejects | Pill "Couldn't copy" (no silent drop), no "Copied". |
| Chunked huge message (`markdown.ts:251`) | Copies the FULL `row.text`, not only the shown part. Sheet shows it all in a scrolling `TextInput` (S7 checks a ~200 KB row stays usable). |
| Row recycled/unmounted after long-press | Flash + sheet state live in the SCREEN, keyed by text, not by the cell. |
| Session switch / reconnect while pill shown | Flash cleared on session change (one `useEffect` on the session key). |
| Mac vs serve session | Same `Row`, phone-local copy: identical (T6). |
| VoiceOver | "Copy message" accessibility action on the row. |

### Tests (red first)

`test/message-copy.test.ts` — each shown FAILING (module missing / stub
returning `null`) before the implementation:
- T1 assistant → markdown source byte-for-byte (`**b**`, a fenced block, `[t](u)`), trailing `\n\n` trimmed.
- T2 user bubble → text; restart prompt → text; photo-only and pdf-only → `empty`; blank `"  \n"` → `empty`.
- T3 fired wake text (`[scheduled …]` prefix and a `schedule` ref) → `null`.
- T4 tool / reasoning / notice → `null`.
- T5 parity: for the last assistant row, `messageCopy(...).text === sessionMenu(rows).find(id==="copy-last").text`.
- T6 the same row object built as a serve-session row and a local one (both just `Row`) copies the same — written as a table over `[user, assistant]` with `at` present/absent.
- T7 `copyFlashShown`: shown at `at`, at `at+2499`, hidden at `at+2500`, hidden for a clock that went backwards, `null` → false.
`test/message-copy-render.test.ts`:
- R1 with `onCopy`, user bubble and assistant row are wrapped in a pressable with `onLongPress` and testID `row-<key>-copy`; tool/notice/fired rows are not.
- R2 without `onCopy` no wrapper (no behaviour change for other callers).
- R3 `CopyFlash` copy state renders "Copied" + "Select text"; empty state renders "No text to copy" and NO "Select text".
- R4 `SelectTextSheet` body is a `TextInput` with `editable === false`, `multiline`, `value` = the text, and NO `selectable` `Text` anywhere in transcript rows other than the fired body.

**Mutation targets** (each must turn a test red, then revert):
- M1 `messageText` returns rendered/stripped text instead of source → T1, T5.
- M2 drop the fired check → T3, R1.
- M3 return `copy` with `""` for photo-only → T2.
- M4 `<=` instead of `<` in `copyFlashShown` → T7.
- M5 `editable` left default (true) in the sheet → R4.
- M6 `session-menu` keeps its own text rule and diverges (e.g. no `trimEnd`) → T5.

Gate before done: `bun test`, `bun run typecheck`, `bun run lint` (baseline clean).

### Simulator check (QA, iPhone 17 Pro sim, light + dark)

- S1 Long-press an assistant answer (~0.4 s): light haptic (device) / pill
  `✓ Copied · Select text` appears above composer, fades after ~2.5 s; paste into
  Notes = markdown source, all paragraphs, lists and code.
- S2 Long-press does NOT show iOS's native "Copy" bubble on any transcript row
  (proves no `selectable` collision).
- S3 Long-press your own message → copied; a photo-only message → "No text to
  copy", dimmed, nothing changed in the clipboard.
- S4 Long-press a link: link behaviour only, no copy. Tap the code block's copy
  icon: still copies just the code.
- S5 Long-press inside a code block → whole message copied.
- S6 "Select text" → sheet; double-tap a word, drag handles across two
  paragraphs and a code line, Copy → paste = exactly that span. "Copy all" works.
- S7 A very long answer (chunked): copy and sheet both carry the full text; sheet scrolls smoothly.
- S8 Tool row, thought, notice, fired wake: long-press does nothing (the wake's
  own selectable body still works).
- S9 Repeat S1/S3 on a Mac session and on a `serve` session.
- S10 Swipe left still reveals the time; scrolling while touching never copies.
- S11 VoiceOver: row offers "Copy message"; Dynamic Type XXL: pill doesn't clip.

### Owner questions

Mockup: `.tentacle/mockups/mobile-copy-text/index.html` (390 pt frames, light + dark).

**Q1 — How is "Select text" reached?**
- **A (consigliata):** long-press copies at once (as you asked) and the pill
  says `✓ Copied · Select text`; tapping "Select text" opens the sheet.
  Zero extra taps for the common case; the part-copy is one tap away for 2.5 s.
- **B:** long-press plays the haptic and opens a small action sheet
  "Copy message / Select text"; copy happens on the tap (one tap more for every
  copy, but "Select text" never times out).

Recommendation: **A** — it matches the binding choice literally (long-press =
copied), and the timeout is harmless: a second long-press brings the pill back.

### Owner answers (2026-11-25 ~20:55)

Owner, verbatim: «A» → **Q1 = A** (as recommended): long-press copies at once; the pill says `✓ Copied · Select text`; tapping "Select text" opens the sheet.

Orchestrator note: this plan was written on 2026-11-21 against an older main (branch merged with main 348b2461 on 2026-11-25); every `file:line` above must be re-verified before use — if one contradicts the code, fix the plan step (AGENTS §8), don't force it.

*— claude-opus-5-5 (orchestrator), 2026-11-25*

## Execution

*— deepseek, 2026-11-25*

### Load-bearing assumption — re-checked on this branch: holds

Re-ran the doc's probe here (output kept in `.tentacle/tmp/mobile-copy-text/probe.out`):

- `react-native@0.88.0`; `RCTParagraphComponentView.mm:344` adds the native
  long-press recogniser when the paragraph is selectable, `:386` lets the menu do
  only `action == @selector(copy:)`, and `:399` copies
  `NSMakeRange(0, attributedText.length)` — one paragraph, whole.
- `RCTUITextView.mm`: **0 hits** for `selectable` ⇒ a read-only multiline
  `TextInput` keeps UIKit's real partial selection. That is what the sheet leans on.
- Before this change `TranscriptRow.tsx` had **0 hits** for `onLongPress` /
  `Clipboard` — no message row copied anything.

So the design is used as written: no `selectable` on transcript rows, long-press =
the whole message, "a part" = the `TextInput` sheet.

### As built, per slice

1. **`src/message-copy.ts` (new)** — `messageText` (`:33`), the `MessageCopy`
   union with its third arm `failed` (`:54`), `messageCopy` (`:64`), `COPY_FAILED`
   (`:78`), `COPY_FLASH_MS = 2500` (`:81`), `copyFlashShown` half-open (`:88`).
2. **`src/session-menu.ts:31-37`** — `said()` now reads `messageText`; the fired
   rule stays out of it (no clock), so "Copy conversation" is byte-identical.
3. **`src/ui/CopyFlash.tsx` (new)** — render only: absolutely positioned pill,
   `testID="copy-flash"`, glyph + word; `testID="copy-flash-select"` exists **only**
   in the `copy` state (the other two have no text behind them to select).
4. **`src/screens/SelectTextSheet.tsx` (new)** — `ui/Sheet` + read-only
   `multiline` `TextInput` (`:50-55`, `editable={false}`) and "Copy all"
   (`:65-72`), wired to the same `copyText` path.
5. **`src/screens/transcript/TranscriptRow.tsx`** — `RowProps.onCopy` (`:117-123`);
   `CopyPress` (`:182-215`: `delayLongPress={LONG_PRESS_MS}`
   (`:219`, 400 ms), `testID={`row-${row.key}-copy`}` (`:204`), no `onPress`, the
   VoiceOver `copy` action (`:207-212`), absent handler ⇒ the row draws exactly as
   before); the wrapper sits in `UserRowBody` (`:368-459`) and around
   `AssistantRowView`'s Markdown + speak (`:462-489`).
6. **`src/screens/transcript/TranscriptCell.tsx:39,66`** — `CellActions.onCopy`
   and the pass-through.
7. **`src/screens/SessionScreen.tsx`** — `copyFlash` / `selectText` state
   (`:810-814`), the one `copyText` path (haptic → `setStringAsync` → pill, and
   `COPY_FAILED` on reject: `:820-831`), `copyMessage` = the pure rule plus the
   haptic-only `empty` branch (`:836-847`), one timer (`:849-855`), the reset on
   session change (`:858-862`, with a `biome-ignore lint/correctness/useExhaustiveDependencies`
   because the body resets state rather than reading it), `onCopy` into the cells
   (`:867`), `<CopyFlash>` ahead of `<OutboxRows` gated by `copyFlashShown`
   (`:2246-2252`), `<SelectTextSheet text={yields ? null : selectText}>` (`:2372-2376`).
8. **`test/message-copy.test.ts` (new, 15 tests)** T1, T2 (prompt / restart /
   photo-only / pdf-only / blank), T3, T4 (tool, thought, notice, compaction), T5
   parity with the header's last-answer copy, T6 Mac vs serve row, T7 the window.
   **`test/message-copy-render.test.ts` (new, 11 tests)** R1–R4 on the
   `artifact-card-render.test.ts` element-walk pattern. 26 tests, green.
9. **`apps/mobile/e2e/flows/06-session-open.yaml:35-50`** — the session the flow
   already opens has a transcript (`row-r1` prompt, `row-r2` answer): assert
   `row-r2-copy`, `longPressOn` it, `extendedWaitUntil` `copy-flash` (5 s), then
   assert `copy-flash-select`. Ids only, because RN's new architecture exposes no
   text to XCUITest (P9, `docs/feat/mobile-session-view.md:170`), and
   `copy-flash-select`'s presence is what pins the state to "Copied" — the two
   other pills offer no action.
10. **`changelog.d/mobile-copy-text.added.md`** — the one bullet from the header.

### Drift from Implementation (two, both justified)

- **D2: the wrapper moved from "`UserRowView`'s bubble" into `UserRowBody`**
  (`TranscriptRow.tsx:368`). `UserRowView` (`:320`) calls hooks, so a
  hook-free element walker (the render-test pattern this repo uses) cannot draw
  it; `UserRowBody` is the same bubble body, already exported for that reason.
  What the person sees is unchanged: the whole bubble — photo tiles included —
  is one long-press target, and the photo *viewer* stays outside it, so tapping a
  tile still opens it (S4).
- **D1: `messageText` also handles a `context` row with `event === "reset"`**
  (`message-copy.ts:39-43`). The plan says "restart prompt → its text", but since
  `mobile-reset-in-timeline` the restart prompt is a `ContextRow`, not a `user`
  row — without this, T2's restart case would be a silent `null`. A `context`
  COMPACT row still returns `null` (a step over a conversation that is gone), which
  is T4's compaction case.

### Honest scope of R1 (as the plan worded it)

R1's "tool / notice / fired get no wrapper" is proven in-render only for the
**notice** row: tool, thought and fired-wake rows draw `StepNode`, which calls
hooks, so an element walker cannot render them at all. Their absence is pinned
instead by the pure rule — T3 (a fired wake → `null`) and T4 (tool, thought,
notice, compaction → `null`) — plus the wrapper's own "absent handler ⇒ no
wrapper" (`CopyPress:199`) that R2 checks. The two halves together are the claim;
neither alone would be.

### Mutation checks (each turned a named test red, then reverted)

| Mutation | Red |
|---|---|
| M1 `messageText` for `assistant` returns rendered text (strips `**`) | T1 |
| M2 drop the fired check in `messageCopy` | T3 |
| M3 blank text → `{kind:"copy", text:""}` | T2 (3 assertions) |
| M4 `<=` instead of `<` in `copyFlashShown` | T7 |
| M5 remove `editable={false}` from the sheet's `TextInput` | R4 |
| M6 `said()` keeps its own `row.text` (no `trimEnd`) | T5 |

All reverted; the two new files are green again (26 pass, 0 fail).

### What was run

- `bun test` from `apps/mobile` on the two new files → 26 pass / 0 fail, 57
  `expect()`s; and together with `session-menu`, `artifact-card-render`,
  `notice-row`, `context-row-render`, `chart-view`, `schedule-view`,
  `transcript-cell`, `step-rail-render`, `step-thought-marker`, `tool-step-view`
  → 138 tests, all green.
- `npx tsc -p . --noEmit` in `apps/mobile` → clean.
- `bunx biome check` on the 9 changed TS files → clean.
- The full `bun run check` (whole-repo typecheck + lint + parallel suite) is the
  orchestrator's merge gate — **not run here**.

### Not verified (no device and no simulator in this environment)

- **S1–S11** (`### Simulator check` above), i.e. everything that needs a phone:
  haptics, the pill's placement/fade, the native long-press vs. `selectable` race
  (S2), the sheet's real double-tap/drag-handle selection (S6), a ~200 KB row
  (S7), VoiceOver (S11) and Dynamic Type XXL (S11). The design's iOS claims were
  verified from the native source, not on hardware.
- **The Maestro flow** (`06-session-open.yaml:35-50`): the local gate cannot run
  it (no iOS simulator here). `longPressOn` is the idiom already in
  `26-drawer.yaml`, `33-hub.yaml` and `44-workflow-editor.yaml`, and both ids it
  asserts exist in the source (`CopyFlash.tsx`: `copy-flash`,
  `copy-flash-select`), but the flow itself is red-or-green only on the gate's
  simulator.
- **`apps/mobile/node_modules` in this worktree is a local symlink** to the main
  checkout's (so `react-native` and `@tentacle/*` resolve). It existed only to run
  the tests and is **not** committed.

## Review

*— (reviewer), (date)*
