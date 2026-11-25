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

*— (executor), (date)*

## Review

*— (reviewer), (date)*
