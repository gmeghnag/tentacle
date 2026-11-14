# feat/mobile-ui-polish — Make the iPhone app look like the approved mockups (+ the owner's three bugs)

> **Status:** implementation (awaiting owner approval; Owner questions below are open)
> **Branch:** `feat/mobile-ui-polish`
> **Size:** L (split into S/M slices below) · **Blast:** contained (only `apps/mobile`, presentation + three pure helpers; no protocol, persistence or daemon change) · **Suited:** claude-opus-5-5 executes; Review is **mandatory fresh-context** (size L)
> **Changelog:** `changelog.d/mobile-ui-polish.fixed.md` (B1–B4: composer hidden by the keyboard / home indicator, Return does not send, `&#39;`/`&quot;`/raw JSON in answers, invisible dark-mode text) and `changelog.d/mobile-ui-polish.changed.md` (the new look)

## Context

*— claude-opus-5-5, 2026-11-14*

**Why.** On 2026-11-14 the owner ran the Release build on a real iPhone 12 Pro
(iOS 18.3.1) and called the UI "orrenda". The UI direction was settled on
2026-11-01: *"the mockups are approved"* (`docs/eval/mobile-app.md:345`). The app
does not follow them: it uses a 2023-style plain grouped list (12 px corners,
text buttons, emoji/Unicode glyphs as icons, a native large-title bar on every
screen, even the chat). The goal is a first-class native iOS app that **matches
the mockups**, with no change to behaviour except where a mockup shows a flow the
app lacks (those are Owner questions, never done silently).

**Mockup source** (gitignored, local): `.tentacle/tmp/mobile-ui/mockups/project/`
— `Main` (Computers), `Pair`, `Sessions`, `Conversation`, `Diff`, `Compose`,
`Approval`, `Offline`, `Lock`, `LiveActivity` (`*.dc.html`) + `canvas.json`. Each
file's `renderVals()` holds its light/dark token table; the values below are
copied from them.

**Owner bug report (2026-11-14 22:30) — Slice 0, fixed before any restyle:**

| # | Symptom (owner) | Cause (verified in code) |
|---|---|---|
| B1 | The message field opens very low, almost cut off at the bottom | (a) **No safe area anywhere**: `react-native-safe-area-context` is a dependency (`apps/mobile/package.json`) but there is no `SafeAreaProvider` and no `useSafeAreaInsets` in `App.tsx` or `src/` (grep: 0 hits). The composer's only bottom spacing is `paddingVertical: 8` (`src/screens/SessionScreen.tsx:294-301`), so on a Face ID iPhone it sits inside the 34 pt home-indicator area. (b) **Keyboard offset missing**: `KeyboardAvoidingView behavior="padding"` with no `keyboardVerticalOffset` (`SessionScreen.tsx:97-101`) inside a native stack whose header is **opaque** (`App.tsx:1197`) — RN's KAV measures its own frame relative to its parent, not the window, so it under-pads by the header's height and the field slides under the keyboard. (c) The Session screen inherits `headerLargeTitle: true` (`App.tsx:1191`, not overridden at `App.tsx:1309`), making that header ~96 pt tall, which both enlarges (b) and wastes chat space. (d) Suspect, to confirm in the repro: a stray `{" "}` text node between `QueueRows` and `OutboxRows` (`SessionScreen.tsx:174`) — a bare string inside a `View`. |
| B2 | Return/Invio does not send | The field is `multiline` (`SessionScreen.tsx:202-211`) with no `onSubmitEditing`, no `submitBehavior`, no `returnKeyType` (grep: 0 hits in `apps/mobile`). In a multiline `TextInput`, Return inserts `\n`. The send button works (`controller.press()` → `compose.press`, which reads and clears the field: `src/session-screen-controller.ts:576-599`). |
| B3 | The model's output shows strange "ASCII" characters | **Confirmed by repro (below):** `marked@12`'s *lexer* HTML-escapes inline text and code spans (`'` → `&#39;`, `"` → `&quot;`, `&` → `&amp;`, `<` → `&lt;`) because v12 escapes in the tokenizer, not the renderer. `src/markdown.ts:70-83` copies `token.text` as is, and `Markdown.tsx:39-44` draws it, so almost every English answer shows `don&#39;t`, `&quot;quit&quot;`, `a &lt; b`. Code blocks are fine (`highlight.ts:199` unescapes them). **Second source:** a tool row shows the **raw JSON arguments** (`{"command":"bun test …"}`): `src/transcript.ts:321` stores `event.arguments` and `TranscriptRow.tsx:141-145` prints it (the TUI shows `Bash  bun test …` via `toolTitle`, `packages/tui/src/render-lines.ts:545-616`). **Third, possible:** ANSI SGR codes in tool output pass through untouched (repro line 4; `TranscriptRow.tsx:161-163`); and the UI's own Unicode glyphs (`＋ ⇥ ↳ ■ ↑ ◷ ⏳ 🖼 ⚠`, `SessionScreen.tsx:200-251`, `ComposeBar.tsx:82-177`) and a literal `` `tentacle` `` with backticks (`SessionsScreen.tsx:139`). Tables are flattened to `a · b` monospace by design (`markdown.ts:44`, `Markdown.tsx:198-214`). |
| B4 | *(found while planning, not reported)* In dark mode answers are black on black | `Markdown.tsx:151-156` (paragraph) and list bodies set no `color`; RN's default text colour is black. Only headings (`:164`) and chunked text (`:237`) get `palette.label`. Inline code uses `palette.card` as its background (`:42`), which is the user bubble's own colour (`TranscriptRow.tsx:61`), so the pill is invisible there. |

**Repro (B3)** — `.tentacle/tmp/mobile-ui-polish/b3/repro.ts`, run 2026-11-14 on this branch (= `main` @ `fcd9138f`):

```ts
// B3 repro: what the phone's markdown tree carries for typical model text.
import { parse, plainText } from "../../../worktrees/mobile-ui-polish/apps/mobile/src/markdown.ts";

const samples = [
  `It's done — the "quit" path & the <Tab> key.`,
  "Use `a < b && c` here.",
  "| a | b |\n|---|---|\n| x's | 1 |",
  "\u001b[32mPASS\u001b[0m 3 tests",
];
for (const s of samples) {
  console.log(JSON.stringify(s), "=>", JSON.stringify(plainText(parse(s))));
}
```

```
$ bun .tentacle/tmp/mobile-ui-polish/b3/repro.ts
"It's done — the \"quit\" path & the <Tab> key." => "It&#39;s done — the &quot;quit&quot; path &amp; the <Tab> key."
"Use `a < b && c` here." => "Use a &lt; b &amp;&amp; c here."
"| a | b |\n|---|---|\n| x's | 1 |" => "a b\nx&#39;s 1"
"\u001b[32mPASS\u001b[0m 3 tests" => "\u001b[32mPASS\u001b[0m 3 tests"
```

**Repro (B1, B2)** — not run yet while planning (no simulator run in this
step). The executor runs it first, on the unmodified branch, and pastes the
output here: see *Tests → Slice 0*. B1's decisive observable is
`maestro hierarchy` bounds (the composer's frame against the keyboard's frame
and against `screenHeight − 34`), plus a screenshot; B2's is `pressKey: Enter`
followed by the absence of `composer-filled`.

**Constraints.** Presentation only (AGENTS §7: logic in pure modules, components
render). Keep every existing `testID` (the Maestro flows' contract, P9). React
Native + Expo, native widgets (no web look). React 19 stays in `apps/mobile` only.

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

**Every screen can be restyled without touching the view-models' decisions,**
because the screens are already dumb renderers over pure modules (stated in
each file's header and true in the code read: `SessionScreen.tsx:6-9`,
`ComposeBar.tsx:6-8`, `Markdown.tsx:2-5`, `TranscriptRow.tsx:1-4`; the decisions
live in `composer.ts:75-103`, `session-view.ts`, `session-list.ts:204-232`,
`computer-rows.ts`). So the restyle changes `.tsx` files plus *new* pure
presentation helpers; the existing unit tests (`apps/mobile/test/*.test.ts`) and
the Maestro flows (`testID`s) must stay green unchanged. The only exceptions are
the B1–B4 fixes and the Owner-question items, listed separately.

### Preconditions

- Safe-area library already installed (`react-native-safe-area-context 5.10.1`,
  `package.json`) — no new native module for B1.
- RN 0.88 `TextInput` supports `submitBehavior` (`"submit"` / `"blurAndSubmit"` /
  `"newline"`, since 0.73) — B2 needs no library. Verify on the simulator in Slice 0.
- `composerAction` already decides send/queue/send-later/stop/none
  (`composer.ts:75-103`); Return must reuse it, never re-decide.
- `toolTitle`'s subtitle rule exists in the TUI (`render-lines.ts:545-616`); the
  app must not import `@tentacle/tui` in the bundle (plan P8,
  `test/transcript-parity.test.ts:7-10`), but a **test** may import it
  relatively — the existing parity pattern.
- The theme is already one module (`src/theme.ts`, colours only, 56 lines) picked
  by `useColorScheme` (`App.tsx:912`) and passed down as `palette`.
- Every screen receives `palette` as a prop; no screen reads colours elsewhere
  except `SettingsScreen.tsx:148` (hard-coded `#8E8E93`).

### Design

#### 1. Design tokens — `src/theme.ts` (pure, extended in place)

One module, no React. `Palette` grows from 11 colours to the mockups' full
table; `type`, `radius`, `space`, `size` are added. The existing names stay as
aliases for one slice so nothing breaks at once, then are removed.

| Token | Light | Dark | Source |
|---|---|---|---|
| `bg` (grouped screen) | `#F2F2F7` | `#000000` | Main/Sessions/Lock |
| `page` (chat screen) | `#FFFFFF` | `#000000` | Conversation/Diff/Compose/Offline |
| `card` | `#FFFFFF` | `#1C1C1E` | Main |
| `sheet` | `#FFFFFF` | `#1C1C1E` | Approval/Pair |
| `fill` (secondary fill: user bubble, button bg, field) | `#EFEFF4` | `#2C2C2E` | Pair/Approval (Main `#E9E9EE`, Sessions search `#E3E3E8` — one value is chosen; differences are < 3 % L) |
| `code` (code block, inline code) | `#F2F2F7` | `#1C1C1E` (on a sheet: `#2C2C2E`) | Conversation / Approval |
| `label` | `#000000` | `#FFFFFF` | all |
| `sec` (secondary label) | `#636366` | `#AEAEB2` | all (today `#6C6C70` / `#8E8E93`) |
| `sep` | `#C6C6C8` (chat: `#D1D1D6`) | `#38383A` (sheet: `#48484A`) | all |
| `accent` (text/icons) | `#0E7490` | `#22D3EE` | all (today dark is `#06B6D4`) |
| `accentFill` / `onAccent` | `#0E7490` / `#FFFFFF` | `#06B6D4` / `#00191F` | filled buttons |
| `tint` (accent-tinted bg) | `#E0F4F8` | `#0B2E36` | badges, running tool row, icon tiles |
| `green` / `orange` / `red` | `#1E7B34` / `#B33000` / `#C4001A` | `#30D158` / `#FF9F0A` / `#FF6961` | status |
| `warnBg` / `warnText` | `#FFF1DC` / `#7A3300` | `#3A2A0C` / `#FFD08A` | Offline banner |
| `glass` / `glassBorder` / `shadow` | `rgba(255,255,255,0.82)` / `rgba(0,0,0,0.08)` / 0 6 20 @ 0.12 | `rgba(44,44,46,0.82)` / `rgba(255,255,255,0.12)` / 0 6 20 @ 0.5 | glass buttons + composer |
| `kw` / `com` (syntax) | `#9B2393` / `#55606B` | `#FF7AB2` / `#8E9AA6` | Conversation code |
| `addBg`/`addStrong`/`addText` | `#E3F5E8`/`#BFE8CB`/`#14612A` | `#0F2A19`/`#1F5232`/`#7EE2A0` | Diff |
| `delBg`/`delStrong`/`delText` | `#FCE8EA`/`#F6C4CA`/`#9F1020` | `#34141A`/`#64222B`/`#FFA3A8` | Diff |
| `dash` | `#8E8E93` | `#636366` | Offline waiting bubble |
| `switchOff` | `#C7C7CC` | `#39393D` | Approval |

Type scale (iOS text styles; RN `allowFontScaling` stays on — Dynamic Type —
with `maxFontSizeMultiplier` 1.4 on dense rows: tool rows, chips, headers):
`largeTitle` 34/41 700 ls 0.37 · `title2` 22/28 700 (sheets) · `title3` 20/25 700
(computer header) · `lockTitle` 28/34 700 · `headline` 17/22 600 · `body` 17/22 ·
`transcript` 16/23 (answers), user bubble 16/22 · `subhead` 15/20 (tool name 15/600)
· `footnote` 13/18 · `caption` 12/16 · `mono` 13 (paths), `monoCode` 12.5/19,
`monoDiff` 12/21, inline code 14. Mono family: `ui-monospace` (SF Mono) if RN
0.88 maps it on iOS, else `Menlo` — decided by one screenshot in Slice 1.

Radii: `card` 26 · `sheet` 38 · `bubble` 20 · `tile` 14 (tool row, code, field)
· `banner` 18 · `queue` 20 · `iconTile` 8 (32 pt) / 12 (44 pt) · `pill` 11 ·
`button` = height/2. Sizes: `touch` 44 · `composer` 48 · `fab` 56 · `rowMin` 60
(project) / 64 (session) / 52 (action) · `bigButton` 50 (sheet) / 54 (lock).
Spacing: screen inset 16, card inner 16, section gap 28 (Computers) / 22
(Sessions), transcript gap 14, header row 52 (list) / 56 (chat).

A test pins **contrast** (WCAG ≥ 4.5:1 for `label`, `sec`, `accent` on `bg`,
`card`, `page`, `fill`, both modes; `accent` on `tint`; `onAccent` on
`accentFill`) — the cheap property that catches a wrong hex, as the TUI's
`theme-contrast.test.ts` does.

#### 2. Shared primitives — `src/ui/*.tsx` (render only)

Each takes `palette` (or `tokens`) and plain props; no branching beyond "is this
prop present". Icons: SF Symbols (Owner Q4) via one `Icon` wrapper so the
choice is in one file.

| Primitive | Mockup | Notes |
|---|---|---|
| `Icon` | inline stroke icons | `name` → SF Symbol (`chevron.left`, `ellipsis`, `plus`, `slider.horizontal.3`, `folder`, `laptopcomputer`, `macmini`, `terminal`, `checkmark.circle`, `arrow.up`, `stop.fill`, `doc.on.doc`, `qrcode.viewfinder`, `faceid`, `wifi.slash`, `clock`, `archivebox`, `square.and.pencil`, `bolt.fill`, `magnifyingglass`, `chevron.right`, `chevron.down`, `doc.on.clipboard`, `bubble.left`). Replaces every emoji/Unicode glyph. |
| `GlassButton` | 44 pt round, `glass` + 1 px `glassBorder` + shadow | variants: icon, text (`Cancel`), `fab` 56 pt; `accessibilityLabel` required |
| `ScreenHeader` | 52/56 pt row under the safe-area top: left/right GlassButtons; `LargeTitle` (34/41) below for list screens; compact centred title + `StatusLine` subtitle for chat screens | replaces the native nav bar (`headerShown: false`), keeps the native-stack swipe-back gesture |
| `GroupedCard` / `Row` / `SectionHeader` | 26 pt cards, rows ≥ 60/64 pt, inset separators (60 pt after an icon tile, 16 pt otherwise), uppercase 13 pt section header | `Row`: optional icon tile, title, mono subtitle, trailing (pill / text / chevron), `dimmed` (cached/offline) |
| `StatusDot` | 6/8 pt dot: filled (online/running), ring (offline) | tone from a pure helper |
| `Pill` | `tint` bg, `accent` text, dot + "1 running" | replaces filled accent badges (`SessionsScreen.tsx:56-64`) |
| `ToolRow` | 48 pt, 14 radius, 1 px `sep` border: status icon · name (15/600) · mono subtitle (ellipsised) · trailing (`exit 0` / `+3 −5` / time) · chevron; running variant on `tint` | content from the pure `tool-summary.ts` |
| `CodeBlock` | `code` bg, 14 radius, 34 pt header (filename/lang + copy button), **horizontal ScrollView**, `kw`/`com` colours | copy = Owner Q4 |
| `Composer` | glass capsule ≥ 48 pt, 17 pt input, round 48 pt action (send `arrow.up` on `accentFill`; stop = `label` bg with `page` square; disabled = `fill`/`sec`); photo button; bottom inset handling (B1) | keeps `composer-*` testIDs |
| `Sheet` | 38 pt top radius, 36×5 grabber, `sheet` bg, 50 pt pill buttons (primary `accentFill`, secondary `tint`, destructive `fill`+`red`, neutral `fill`) | inside the existing native `Modal` (`pageSheet`) — native presentation and swipe-to-dismiss stay |
| `Banner` | 18 pt radius, icon + bold line + body (`warnBg`/`warnText`, or `tint`) | offline / stale / archived / errors |
| `EmptyState` / `Loading` | centred `sec` text + optional action; native `ActivityIndicator` | every list's empty/loading/error |

#### 3. Pure helpers (new, unit-tested, React-free)

- `src/markdown.ts` — `decodeEntities()` applied to `text`/`escape`/`codespan`
  tokens and table cells: exactly the set `marked@12` escapes (`&amp; &lt; &gt;
  &quot; &#39;`), `&amp;` last. (B3)
- `src/ansi.ts` — `stripAnsi()` for tool output and args (CSI `\x1b[…<letter>`
  and OSC `\x1b]…\x07`, broader than the TUI's SGR-only regex because the phone
  never interprets any of them). (B3)
- `src/tool-summary.ts` — `toolSummary(row)` → `{ label, subtitle, trailing:
  {kind:"exit"|"diff"|"elapsed"|"none", …}, tone }`; the subtitle rule mirrors
  `toolTitle`, pinned by a parity test that imports the TUI relatively (test
  only). `trailing` uses only fields the row has (`status`, `diff` counts,
  `durationMs`); an exit code is shown only if `ToolResult` carries one —
  verify in Slice 3, otherwise `ok`/`error` icon only (no invented data). (B3)
- `src/composer.ts` — add `returnKeyAction(action)`: Return presses only for
  `send` / `queue` / `send-later`; **never `stop`** (an empty field + Return
  while a turn runs must not cancel the turn) and never `none`. (B2)
- `src/composer-layout.ts` — `composerBottomPadding({ insetBottom, keyboard })`
  → `keyboard ? 8 : max(insetBottom, 8)`; one place for B1's rule.
- `src/session-groups.ts` — split the existing Active section into **Running**
  (entry running) and **Idle**, keep Archived; plus the inline meta line
  (`Running · 2 attached · now`) from the badges `session-list.ts` already
  computes. Pure regroup, no new data.
- `src/computer-status.ts` — `computerStatus(row)` → `{ tone: online|offline|
  attention, text }` from `ComputerRow.state/status`; `sasGroups("482913")` →
  `["482","913"]` for the Pair code.

#### 4. Navigation and layout

- Wrap the app in `SafeAreaProvider` (`App.tsx`). Every screen uses
  `ScreenHeader` with `headerShown: false` (consistent on iOS 18 and 26; the
  mockups' glass buttons are not the iOS 18 nav bar). Swipe-back stays
  (`gestureEnabled` is the native-stack default).
- List screens (`Computers`, `Sessions`, `Settings`): `bg` background, large
  title scrolls with content.
- Chat screen (`Session`): `page` background, compact header, the transcript
  bottom-anchored, `KeyboardAvoidingView` with offset 0 (the screen now starts at
  the window top, so KAV's parent-relative frame equals the window frame — this
  is what removes B1(b) structurally), `Composer` with `composerBottomPadding`.
  `keyboardDismissMode="interactive"` on the list (native chat feel).

#### 5. Screen-by-screen gap list (current → mockup)

**Computers** (`ComputersScreen.tsx`, mockup `Main`)
- Layout: "Settings" and "Pair a computer" are full-width text cards at the top
  (`:66-81`) → two GlassButtons top-right (settings sliders, accent `+`), plus a
  "Pair a computer" action card with the `qrcode.viewfinder` icon and the
  footnote `Run tentacle pair…` at the **bottom**.
- Grouping: one 12 pt card per computer with an uppercase grey name (`:83-84`,
  `:175-176`) → a 20/25 bold **computer header** with device icon + StatusDot +
  status text (`Online` green / `Offline · …` ring), then a 26 pt card of
  project rows (icon tile 32 pt `tint`, title 17, mono path 13 `sec`, trailing
  pill `1 running` or `Idle`, chevron). Unreachable/cached rows dimmed with a
  dashed tile.
- Actions: inline "Pair again" / "Remove" text buttons (`:99-118`) and an inline
  confirmation card (`:121-146`) → Owner Q5 (context menu / action sheet);
  confirmation becomes a native `Alert`/action sheet.
- States: loading spinner (`App.tsx:1178`) → keep native; error card
  (`:147-153`) → `Banner`.
- Missing vs mockup: "direct/relay" transport word (only if the link knows it;
  else omitted — no invented data); "seen 2 h ago" (only if a last-seen time
  exists; verify `computer-memory.ts`).

**Pair** (`PairScreen.tsx`, mockup `Pair`)
- Scanner: today a card flow on the grouped background with 12 pt cards
  (`:287-301`) → full-screen dark camera, glass `Cancel` (text) + paste-code
  GlassButton, 240 pt rounded viewfinder corners in `#22D3EE`, a "Code found"
  chip, instruction text below.
- Confirmation: a bottom `Sheet` (38 pt, grabber) with title "Compare the code"
  22 bold, explanation, **the SAS in mono 40/48 split in two `fill` boxes**
  (`sasGroups`; today one 40 pt bold string, `:301`), the device-name field
  (48 pt, 14 radius, `fill`), a waiting row with spinner, and "Codes don't match"
  as a 50 pt `fill` pill.
- Error/expired/declined states keep their texts and testIDs, restyled as
  `Banner` + pill buttons. Camera-denied card → `EmptyState` with the Settings
  action.
- Header: the native "tentacle" title with a text "Back" (`App.tsx:1203-1211`)
  → `ScreenHeader` with glass `Cancel`.

**Sessions** (`SessionsScreen.tsx`, mockup `Sessions`)
- Header: native title → back GlassButton + `…` (Owner Q2) + large title
  (project name) + subtitle `MacBook Pro · ~/path` (mono).
- Search field (44 pt `fill` capsule) → Owner Q2.
- Sections: Active/Archived (`:142-143`) → Running / Idle / Archived
  (`session-groups.ts`), 26 pt cards, rows ≥ 64 pt, running row title 600.
- Badges as filled accent pills (`:56-64`) → inline meta line with dot,
  `terminal` icon + "2 attached", relative time.
- Archived rows: `archivebox` icon, `sec` colour, "Archived Oct 26".
- New-session FAB (56 pt glass) → Owner Q2.
- States: loading spinner OK; error card → `Banner` + Retry pill; empty text
  shows literal backticks (`:139`) → `EmptyState` with mono `tentacle`; stale
  "Reconnecting…" → `Banner`; pull-to-refresh kept; "Load more" → row.

**Conversation** (`SessionScreen.tsx` + `TranscriptRow.tsx` + `Markdown.tsx`, mockup `Conversation`)
- Header: native large title (`App.tsx:1191`) → compact centred title + status
  line (`Running · 2 attached` with accent dot / `Offline · synced 14:02`), back
  and `…` GlassButtons.
- Background `groupedBackground` (`SessionScreen.tsx:99`) → `page` white/black.
- User message: card bubble 10 radius (`TranscriptRow.tsx:61`, `:214`) → right-
  aligned `fill` bubble, 20 radius, max ≈ 77 % width, 16/22.
- Assistant: 15/21 text in a padded row (`Markdown.tsx:248`) → full-width
  16/23 text, no bubble; inline code mono 14 on `code` with 5 radius; fenced
  code → `CodeBlock` (header with filename/lang + copy, horizontal scroll,
  12.5/19); headings 22/20/18/17 bold kept; lists with hanging bullets; quote
  with `sep` bar; links accent. **Tables** → a real grid in a horizontal
  `ScrollView` (header row 600, `sep` lines, mono only for code cells) instead of
  `a · b` lines — needs the cells kept per column (they already are:
  `markdown.ts:160-167`).
- Reasoning: "thinking" caption + left bar → collapsed one-line `sec` row
  ("Thought for 4 s", chevron) expanding on tap (presentation state, as the tool
  output already is).
- Tool rows: `label · status` + raw JSON args + grey mono output inside a card
  (`TranscriptRow.tsx:126-170`) → `ToolRow` (status icon green/red/accent
  spinner, name, mono subtitle from `tool-summary.ts`, trailing, chevron);
  output expands **below** the row in a `CodeBlock`-style panel (ANSI stripped).
  Running tool: `tint` row with spinner and elapsed time.
- Streaming caret: the accent 9×18 block at the end of the streaming answer
  replaces the separate "working…" text (`SessionScreen.tsx:153-158`) — the
  `turn-running`/`turn-idle` element must stay on screen (P9), so it becomes the
  zero-size observable it is for `composer-filled`, and the visible caret is a
  separate view.
- Notices/banners: plain 13 pt text bar (`:102-127`) → `Banner`.
- Composer: flat bar with hairline top border, 36 pt button, `＋`/`⇥`/`↳`/`■`/`↑`
  glyphs (`:181-254`) → glass capsule + 48 pt round action, SF Symbols; empty
  state "Nothing here yet — say something below." → `EmptyState`.
- Keyboard/safe area: B1. Haptics: light impact on send, success on turn end
  (Owner Q4).

**Diff** (`DiffView.tsx`, mockup `Diff`)
- Always expanded inside the tool card, path + counts as one mono line
  (`DiffView.tsx:44-47`) → `ToolRow` header (chevron down when open), a
  `+3 −5 · one change` line, a hunk header on `code`, **two gutters** (old/new
  number, 30 pt each) + sign column, full-row `addBg`/`delBg` tints with
  `addText`/`delText`; `addStrong`/`delStrong` word highlights only if
  `diff-view.ts` already yields word ranges (else omitted — no new diff logic in
  this task). Long lines: horizontal scroll for the whole hunk.
- Collapsed by default with tap to expand — today it is always open. This is
  presentation state (like tool output); the `diff-<callId>` testID stays on the
  block and flows that assert it must tap first → **check** flows `08-*`/`09-*`;
  if any asserts a diff without tapping, keep the newest diff expanded instead.

**Compose — writing while a turn runs** (`ComposeBar.tsx`, mockup `Compose`)
- Running tool pinned above the composer: `tint` 52 pt row with spinner,
  command, elapsed, and a white **Stop** pill (today Stop is only the composer
  button's `■`).
- Queue: grey 12 pt `↳` lines (`ComposeBar.tsx:74-104`) → a `fill` 20 pt card
  "Queued · the agent reads these at its next step", rows with `clock` icon 15/21,
  and **Send now** as a 44 pt `accentFill` pill with `bolt.fill` (today `⇥`,
  `SessionScreen.tsx:219-228`).
- Composer action while typing during a turn: accent `arrow.up` ("Add to
  queue"); with an empty field it is the Stop square (mockup Conversation) —
  same `composerAction`, only the look changes.
- Returned rows / Take: restyled as queue rows with a `Take` text button;
  photo chips: `⏳ 🖼 ⚠` emoji (`ComposeBar.tsx:137`) → thumbnails/`photo`
  icon + spinner/`exclamationmark.triangle` in 14 pt capsules.

**Approval** (`PermissionSheet.tsx`, mockup `Approval`)
- Native `pageSheet` kept (`PermissionSheet.tsx:33-35`), content restyled as
  `Sheet`: 44 pt `tint` icon tile + title 22 bold + "project · session" 14 `sec`;
  the command in a `code` box (mono 14, wraps); the working dir line with
  `folder` icon.
- Options: hairline-bordered 10 radius rows (`:154`) → 50 pt pills in the
  daemon's order, styled by option kind (allow-once → `accentFill`; allow-always
  → `tint`; deny → `fill` + `red`; reply → `fill` + `bubble.left`). Kind comes
  from the option ids the daemon sends — a pure `optionStyle(optionId)` helper
  in `permission-sheet.ts`; unknown ids → neutral.
- Reply input / arming / returned states keep their testIDs, restyled.
- "Auto-accept" switch and "Also asked on MacBook Pro · the first answer wins"
  → Owner Q3.

**Offline** (`SessionScreen.tsx` banner + `OutboxRows`, mockup `Offline`)
- Header subtitle `Offline · synced HH:MM` (needs the last-sync time; use what
  `session-view.ts`'s banner already knows, else just `Offline`).
- `warnBg` banner "<Computer> is unreachable / You are reading the saved
  copy…" with `wifi.slash`.
- Outbox rows: grey `◷ waiting for the network —` lines (`ComposeBar.tsx:
  161-182`) → right-aligned **dashed** bubbles (1.5 pt `dash`) with an `…`
  44 pt options button (opens the existing `OutboxDecisionSheet`, today a full
  `Modal` with plain rows, `OutboxDecisionSheet.tsx:47-117` → `Sheet`), and the
  caption "Waiting for network · sent on reconnect if nothing changed".
- Send button disabled look: `fill` + `sec`.

**Lock** (`LockGate.tsx`, mockup `Lock`)
- Centred title 22/600 + 14 pt subtitle + small 12-radius button (`:179-213`)
  → app icon 96 pt (22 radius) centred, "tentacle is locked" 28/34 bold, "Your
  sessions stay hidden, in the app switcher too." 16/22 `sec`; bottom: 54 pt
  full-width `accentFill` "Unlock with Face ID" with `faceid` icon, footnote
  "Locks after N in the background. Change it in Settings." (N from the lock
  setting already in `App.tsx`). "Use Passcode" text button: only if
  `lock-auth.ts` already allows the device-passcode fallback in the same call
  (then it is the same action); otherwise not added (behaviour).
- The `no-passcode` notice → `Banner`. Modal semantics untouched (F13/F14).

**Settings** (`SettingsScreen.tsx`, no mockup) — apply the system: large title,
26 pt grouped cards, 44 pt rows, checkmark SF Symbol, hard-coded `#8E8E93`
(`:148`) → `sec`.

**LiveActivity** — out of scope (a native widget; `docs/feat/mobile-live-activity.md`).

**Cross-cutting**
- Dark mode: every `Text` gets an explicit colour (B4); verified by screenshots
  in both appearances.
- Safe areas: top inset in `ScreenHeader`, bottom in `Composer` / FAB / sheets.
- Keyboard: KAV + interactive dismiss in chat; Pair device-name field and
  permission reply input stay visible above the keyboard (sheet content in a
  `ScrollView` with `keyboardShouldPersistTaps="handled"`).
- Animation: native-stack push/pop and sheet slide kept; `LayoutAnimation`
  (easeInEaseOut) for queue rows, tool expand and diff expand; no custom
  animation library.
- Haptics: Owner Q4.
- Accessibility: every icon-only button has `accessibilityLabel` (the mockups
  give the strings), 44 pt minimum hit area (`hitSlop` where the visual is
  smaller), Dynamic Type on.

### Files

Dependency order; every slice is S or M and keeps the suite green on its own.

**Slice 0 — bugs (M)**
1. `apps/mobile/src/markdown.ts` — `decodeEntities` in `inline()` (text,
   escape, codespan) and `cellText`. (B3)
2. `apps/mobile/src/ansi.ts` (new) — `stripAnsi`. (B3)
3. `apps/mobile/src/tool-summary.ts` (new) — subtitle rule; `TranscriptRow.tsx`
   shows `subtitle` instead of `args`, output through `stripAnsi`. (B3)
4. `apps/mobile/src/composer.ts` — `returnKeyAction`. (B2)
5. `apps/mobile/src/composer-layout.ts` (new) — `composerBottomPadding`. (B1)
6. `apps/mobile/App.tsx` — `SafeAreaProvider`; Session screen
   `headerLargeTitle: false`. (B1)
7. `apps/mobile/src/screens/SessionScreen.tsx` — `keyboardVerticalOffset` =
   `useHeaderHeight()` (until Slice 3 removes the native header), bottom
   padding, remove the stray `{" "}` (`:174`), `submitBehavior="submit"`,
   `returnKeyType="send"`, `onSubmitEditing` → `returnKeyAction` →
   `controller.press()`. (B1, B2)
8. `apps/mobile/src/screens/transcript/Markdown.tsx` — explicit `label` colour
   on paragraphs/list bodies; inline code on `code` token. (B4)
9. Tests (below) + `apps/mobile/e2e/flows/23-composer-keyboard.yaml` (new; B1,
   B2) + `changelog.d/mobile-ui-polish.fixed.md`.

**Slice 1 — tokens + primitives (M)**: `src/theme.ts` (tokens, aliases kept),
`src/ui/{Icon,GlassButton,ScreenHeader,GroupedCard,Row,SectionHeader,StatusDot,
Pill,Banner,EmptyState,Sheet}.tsx`, `test/theme.test.ts` (contrast),
`package.json` (+ deps per Owner Q4, then `expo prebuild`/dev-client rebuild).

**Slice 2 — Computers + Pair (M)**: `src/computer-status.ts` (+ test),
`ComputersScreen.tsx`, `PairScreen.tsx`, `scanner.tsx` (viewfinder overlay
only), `App.tsx` (`headerShown: false` on these routes).

**Slice 3 — Sessions + Conversation (M)**: `src/session-groups.ts` (+ test),
`SessionsScreen.tsx`, `src/ui/{ToolRow,CodeBlock,Composer}.tsx`,
`SessionScreen.tsx` (ScreenHeader, page bg, KAV offset 0),
`TranscriptRow.tsx`, `Markdown.tsx` (CodeBlock, table grid), `App.tsx`.

**Slice 4 — Diff + Compose + Approval (M)**: `DiffView.tsx`, `ComposeBar.tsx`,
`src/permission-sheet.ts` (`optionStyle` + test), `PermissionSheet.tsx`.

**Slice 5 — Offline + Lock + Settings (S)**: `ComposeBar.tsx` (`OutboxRows`),
`OutboxDecisionSheet.tsx`, `LockGate.tsx`, `SettingsScreen.tsx`.

**Slice 6 — polish (S)**: haptics (Q4), `LayoutAnimation`s, dark-mode pass,
remove the old `Palette` aliases, `changelog.d/mobile-ui-polish.changed.md`,
the screenshot flow `apps/mobile/e2e/flows/ui-shots.yaml` + its seed.

### Failure modes

- **Return while a turn runs with an empty field** → `returnKeyAction` returns
  null for `stop`: nothing happens (a keyboard key never cancels a turn).
- **Return with only whitespace** → `composerAction` is `none(blank)` → no-op,
  text kept (no silent clear).
- **Return on a dead link** → `send-later` → the outbox, exactly as the button.
- **Double submit** (Return + button tap in one frame) → both go through
  `compose.press`, which reads and clears the field in one step
  (`session-screen-controller.ts:579-587`); the second read is empty → `none`.
  Pinned by a test.
- **IME composition** (Japanese/Chinese keyboards: Return confirms a candidate)
  → iOS sends `onSubmitEditing` only for a real Return, not for candidate
  confirmation; verify once on the simulator with the Japanese keyboard.
- **Keyboard on a device without a home indicator** (SE) → `insetBottom` 0 →
  padding 8, same as today.
- **Rotation / iPad split** (`supportsTablet: true`) → insets come from the
  provider on every layout; screenshots on one iPad size in Slice 6.
- **`decodeEntities` on text that literally contains `&amp;`** → `marked`
  escapes `&` only when it is not already an entity, so `&amp;` in the source
  reaches the tree as `&amp;` and decodes to `&` — the same as Markdown in any
  renderer. Pinned.
- **Tool args not JSON** → `toolSummary` falls back to the raw string (as the
  TUI does), ANSI-stripped and one line.
- **Unknown permission option id** → neutral style, still shown (never dropped).
- **Dark/light switch while a sheet is open** → palette is a prop from
  `useColorScheme`; every primitive re-renders.
- **Dynamic Type at the largest sizes** → rows grow (min heights, not fixed
  heights); headers capped by `maxFontSizeMultiplier`.
- **A flow asserts something now hidden** (collapsed diff, collapsed thinking)
  → the full e2e run in Validation catches it; fix by keeping the newest one
  expanded, not by deleting the assertion.

### Tests

Red before green (AGENTS §9) for every bug; each red output is pasted into
Execution.

**Slice 0**
- `test/markdown.test.ts` +: `It's "x" & <y>` → text exactly `It's "x" & <y>`;
  code span `a < b && c` → `a < b && c`; table cell `x's` → `x's`; literal
  `&amp;` → `&`. **Red today** (repro above).
- `test/ansi.test.ts` (new): SGR, CSI cursor codes and OSC links removed; plain
  text untouched; a lone `\x1b` kept as is (no over-strip).
- `test/tool-summary.test.ts` (new): shell → command, fs_* → path, search →
  `pattern in path`, non-JSON → raw; **parity**: for each case equals the TUI's
  `toolTitle(...).subtitle` (relative test-only import). Red today: the row's
  shown string is `row.args` (the JSON) — the test asserts the fold's tool row
  through `toolSummary`, and a companion asserts `TranscriptRow` no longer reads
  `args` (a grep-style test is not used; the property is the summary function's
  output).
- `test/composer.test.ts` +: `returnKeyAction` for each `composerAction` kind;
  `stop` and `none` → null.
- `test/composer-layout.test.ts` (new): inset 34/keyboard closed → 34; inset 34/
  keyboard open → 8; inset 0 → 8.
- `test/session-screen-compose.test.ts` +: two presses in a row send once.
- **Maestro `23-composer-keyboard.yaml`** (red on the current build):
  1. open a session, `tapOn: composer-input`, then a JS step that runs
     `maestro hierarchy` (or the flow's `copyTextFrom`-free bounds check) and
     asserts the input's bottom ≤ the keyboard's top; hide keyboard and assert
     input bottom ≤ screenHeight − 34; `takeScreenshot` both states.
  2. `inputText: "hello"`, `pressKey: Enter`, `assertNotVisible:
     composer-filled`, then wait for the new user row (`row-*` of the mock
     model's reply, as flow `07-prompt.yaml` does).
  If `maestro hierarchy` does not expose the keyboard frame, fall back to the
  screenshot comparison and say so in Execution (one line).
- B4: screenshot of a seeded answer in dark appearance, before/after (the
  harness cannot read colours otherwise).

**Slices 1–6**: `test/theme.test.ts` (contrast table above, red if any pair
fails), `test/computer-status.test.ts`, `test/session-groups.test.ts`,
`permission-sheet.test.ts` + `optionStyle`. Existing tests unchanged and green.
Non-vacuity: for the contrast test, set `sec` to `#AEAEB2` on white and see it
fail; for `returnKeyAction`, map `stop` to press and see the test fail.

**Validation (every slice, and before done)**
- `bun test apps/mobile` per slice; before done: `bun run check` (typecheck incl.
  `tsc -p apps/mobile`, lint clean, full test) against the §6 baseline.
- `bun run e2e:mobile --ios 18` and `--ios 26`: every existing flow green
  (testIDs unchanged).
- **Screenshots vs mockups**: `apps/mobile/e2e/flows/ui-shots.yaml` walks every
  screen with the seeded daemon + mock model (Computers, Pair scanner + compare
  sheet, Sessions, Conversation with markdown/code/table/tools, Diff expanded,
  Compose with queue, Approval, Offline with outbox, Lock) and
  `takeScreenshot`s each; run twice after `xcrun simctl ui <udid> appearance
  light|dark` on iPhone 16 Pro (390×844 class, the mockups' size). Mockup PNGs:
  a scratch script in `.tentacle/tmp/mobile-ui/` expands each `*.dc.html`'s
  `{{t.*}}` with its own `renderVals` table (light and dark) and opens it in the
  **same simulator's Safari** (`xcrun simctl openurl`, served by a local
  `bun` static server) → `xcrun simctl io booted screenshot`, so fonts and
  scale match. Side-by-side PNGs (`<screen>-<mode>.png`, app left, mockup right)
  under `.tentacle/tmp/mobile-ui/compare/`; the list of residual differences,
  each accepted or fixed, goes into Execution.

## Owner questions

*— claude-opus-5-5, 2026-11-14*

### Owner questions

1. **Return key.** Should Return send the message (newline only by pasting
   text), or insert a new line as in iMessage? *Recommendation:* Return sends,
   the key reads "Send", like Enter in the terminal app; while a turn runs it
   queues; it never stops a turn.
2. **Sessions extras the app does not have** (search field, "New session"
   button, "…" menu). *Recommendation:* add the search now (it only filters the
   list on the phone); leave "New session" and the menu for a separate task,
   because they need new work on the computer side.
3. **Permission sheet extras** ("Auto-accept" switch, "Also asked on MacBook
   Pro"). *Recommendation:* not in this task — show only the answers the
   computer sends; do auto-accept as its own task, since it changes what gets
   approved.
4. **New native add-ons** (SF Symbols icons, haptics, copy button on code):
   `expo-symbols`, `expo-haptics`, `expo-clipboard`; each needs one app rebuild.
   *Recommendation:* yes to all three — they are what makes it feel like a
   real iPhone app; no blur library (the mockups' translucent colours are
   enough).
5. **Remove / Pair again on Computers** move off the screen into a menu
   (long-press or a "…" button with an iOS action sheet), as the mockup has no
   visible buttons. *Recommendation:* yes, long-press + action sheet, with a
   confirmation alert for Remove; the tests are updated to open the menu first.

## Execution

*— (pending)*

## Review

*— (pending)*
