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
   the screen's own window `y` (`measureInWindow`; *amended in Execution*:
   `useHeaderHeight()` is in `@react-navigation/elements`, not a dependency of
   `apps/mobile`), bottom padding, remove the stray `{" "}` (`:174`),
   `submitBehavior="submit"`, `returnKeyType="send"`, `onSubmitEditing` →
   `controller.pressReturn()` (*amended*: the `returnKeyAction` gate runs in the
   controller on the CURRENT action, not on the rendered one) → `press()`. (B1, B2)
8. `apps/mobile/src/screens/transcript/Markdown.tsx` — explicit `label` colour
   on paragraphs/list bodies; inline code and code blocks on a `codeBackground`
   that differs from the surface (*amended*: there is no `code` token before
   Slice 1, and its planned values equal today's surfaces). (B4)
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

#### Owner decisions (2026-11-14)

1. Return **sends** (key labelled Send; queues while a turn runs; never stops a turn) — as recommended.
2. Sessions: **search now**; "New session" and the "…" menu are a separate task — as recommended.
3. **NOT as recommended: the permission sheet gets the "Auto-accept" switch and the "Also asked on <computer>" note NOW.** Wire the switch to the session's EXISTING shared auto-accept (the same flag the TUIs share and Shift+Tab flips; find its protocol method and cite it), visible state on every client; laptop-side gating unchanged (AGENTS §7: a phone toggle sets the policy the laptop enforces, never a lasting approval). If a protocol/daemon change is needed, name it and keep it minimal; a `protocol.d/` note if breaking.
   > **Plan correction (executor, Slice 4, 2026-11-15) — this decision's premise does not hold; STOPPED, owner decision needed.** There is no shared auto-accept: it is each TUI's own local state (`packages/tui/src/permission-ui.ts:47-60`, `autoApproves(req, own)`; `StatusBar.tsx:110`), no protocol method or field carries it (`rg -i "autoaccept|auto_accept|permission_mode" packages/protocol/src` → only the wake-turn notes), and it deliberately never answers another device's turn (owner Q3, `docs/feat/tui-foreign-turns.md` C5). A phone switch would need a NEW session-level policy on the wire and on the daemon, i.e. its own `feat` with a security design (§7 "a pod is not trusted", single broker). The "Also asked on <computer>" note has no data on the phone either (an ask carries no list of the other clients asked). Neither was built.
4. **SF Symbols + haptics + copy-on-code AND real iOS blur** (`expo-blur` for the glass buttons/bars/sheets, with the mockups' translucent colours as the fallback where blur is off, e.g. Reduce Transparency).
5. Computers: long-press + iOS action sheet ("…" button too); Remove asks for confirmation — as recommended.

> Owner quality bar (2026-11-14 22:45), binding for plan, execution and review of feat/mobile-ui-polish:
> "Oltre a quei bugs rivedi bene tutto. Deve essere un'app fruibile e bella esteticamente fin da subito. Così sembra una bozza minimale fatta da copia-incolla su StackOverflow."
> => Production quality on EVERY screen, not a minimal pass: native iOS feel (large titles, grouped insets, glass round buttons, sheets, swipe-back, haptics, smooth keyboard), the approved mockups as the floor, light+dark, empty/loading/error/offline states designed, no default RN look, no placeholder text, consistent spacing/typography from one token module. Each slice ends with simulator screenshots (light+dark) side by side with the mockup, and a fresh-context VISUAL review (Fable) that rejects anything that still looks like a draft.

*— claude-opus-5-5 (orchestrator), 2026-11-14*

## Execution

### Slice 0 — bugs

*— claude-opus-5-5, 2026-11-14*

**Load-bearing check, re-run first (holds).** The B3 repro reproduces unchanged
on this branch (same four lines as *Context*). `rg` for `SafeAreaProvider |
useSafeAreaInsets | onSubmitEditing | submitBehavior | returnKeyType |
useHeaderHeight` in `apps/mobile/App.tsx` and `src/`: 0 hits. The screens still
render values from the controllers, so the Slice 0 fixes are the pure helpers
plus the `.tsx` wiring. RN's KAV math (`KeyboardAvoidingView.js:107-119`:
`frame.y + frame.height − (screenY − keyboardVerticalOffset)`, `frame` from
`onLayout` = parent-relative) confirms B1(b).

**As built, in dependency order** (each step red → green):
1. `src/markdown.ts` — `decodeEntities()` (`&lt; &gt; &quot; &#39;`, then `&amp;`
   last), applied to `text`/`escape`, `codespan`, image alt text; table cells go
   through the same `inline()`. Tests: `test/markdown.test.ts` + 6 cases (prose,
   code span, table cell, literal `&amp;`, `&amp;lt;` → `&lt;`, link/alt text).
2. `src/ansi.ts` (new) — `stripAnsi()`: CSI `ESC [ params intermediates final`
   and OSC `ESC ] … BEL|ESC \`; a lone ESC is kept. `test/ansi.test.ts` (5).
3. `src/tool-summary.ts` (new) — `toolSummary(row)` → `{ label, subtitle,
   output }`: the TUI's `toolSubtitle` rule case for case, subtitle and output
   through `stripAnsi`. `TranscriptRow.tsx` draws `summary.subtitle` instead of
   `tool.args` and `summary.output` instead of `tool.output`.
   `test/tool-summary.test.ts` (17): rows through the app's OWN fold
   (`transcript.ts` `apply`), 11 parity cases against the TUI's `toolTitle`
   (label and subtitle), non-JSON fallback, escapes stripped.
4. `src/composer.ts` — `returnKeyAction(action)`: the action for `send` / `queue`
   / `send-later`, `null` for `stop` and `none`. `test/composer.test.ts` + 3.
5. `src/composer-layout.ts` (new) — `composerBottomPadding({insetBottom,
   keyboard})` = `keyboard ? 8 : max(insetBottom, 8)`.
   `test/composer-layout.test.ts` (4).
6. `src/session-screen-controller.ts` — `pressReturn()`: `press()` only when
   `returnKeyAction(view().composer.action) !== null`.
   `test/session-screen-compose.test.ts` + 6 (two presses send once; Return
   sends; Return + tap send once; Return on an empty field with a running turn
   does not cancel, with a control showing the button DOES; Return with text
   during a turn steers; Return on a blank field keeps it). The harness's fake
   turn now counts `cancel()` calls.
7. `App.tsx` — the default export wraps the shell (renamed `AppShell`) in
   `SafeAreaProvider`; the `Session` route sets `headerLargeTitle: false`.
8. `src/screens/SessionScreen.tsx` — an outer `View` measured with
   `measureInWindow` gives KAV its `keyboardVerticalOffset`; the composer's
   `paddingBottom` = `composerBottomPadding(insets.bottom, keyboard)` (keyboard
   from `keyboardWillShow/Hide`, `Did*` on Android); stray `{" "}` removed;
   `submitBehavior="submit"`, `returnKeyType="send"`, `onSubmitEditing` →
   `controller.pressReturn()`.
9. `src/screens/transcript/Markdown.tsx` — paragraphs (so list bodies and quotes
   too) get `color: palette.label`; code (inline and block) uses a new optional
   `codeBackground` prop (default `card`); the user bubble passes
   `groupedBackground`.
10. `e2e/flows/23-composer-keyboard.yaml` + `23-history.js` (new); `e2e/run.ts`
    (`FLOWS` + `KEYBOARD_ID` fresh session); `test/e2e-flows.test.ts` lists it
    with the compose flows (own session, a `composer-*` id, daemon truth last).
11. `changelog.d/mobile-ui-polish.fixed.md`.

**Red before green (pasted).** For the new modules the red was taken against a
stub that reproduces TODAY's behaviour (so it fails on the property, not on an
import):
```
markdown (before decodeEntities)       Expected: "It's "x" & <y>"   Received: "It&#39;s &quot;x&quot; &amp; <y>"
                                       Expected: "Tom & Jerry"      Received: "Tom &amp; Jerry"   … 6 fail
tool-summary (stub: subtitle = args)   Expected: "bun test"         Received: "{"command":"bun test"}"   … every case fail
                                       Expected: "red"              Received: "\x1b[31mred\x1b[0m"
returnKeyAction (stub: null = today)   (fail) send / queue / send-later: Return does what the button does
pressReturn (stub: naive → press())    (fail) Return on an empty field while a turn runs never stops it — Expected: 0  Received: 1
composerBottomPadding (stub: always 8) (fail) Face ID iPhone, keyboard closed — Expected: 34  Received: 8
```
`two presses in one frame send ONCE` was green before the change — it PINS the
existing read-and-clear (the plan's failure mode), it does not fix anything.

**Mutations (each run, then reverted):**
| Mutation | Caught by |
|---|---|
| `decodeEntities`: `&amp;` decoded FIRST | `&amp;lt;` → `&lt;` case |
| `stripAnsi` returns its input | 3 `ansi` cases + 2 `tool-summary` cases |
| `returnKeyAction` maps `stop` → the action (the plan's named one) | `stop → null` |
| `pressReturn` ignores the gate (`|| true`) | "never stops it" |
| `composerBottomPadding` ignores `keyboard` | "keyboard open: the minimum" |

**Drift from Implementation (and why).**
- **`useHeaderHeight()` → `measureInWindow`.** The hook lives in
  `@react-navigation/elements`, which is only a transitive dependency
  (`native-stack` re-exports `useAnimatedHeaderHeight`, an `Animated.Value`).
  Adding a dependency and a lockfile change for a value Slice 3 sets to 0 was
  not worth it; the screen's own window `y` is EXACTLY the quantity KAV's
  parent-relative frame misses, it is right on iPad/rotation too, and it becomes
  0 by itself when Slice 3 removes the header. Plan step 7 amended.
- **The Return gate is in the controller (`pressReturn`), not the screen.** The
  plan had the screen call `returnKeyAction` on the rendered action and then
  `press()`, but `press()` re-reads the action: a second Return before a
  re-render (field already cleared, the turn now running) would pass a stale
  `send` through the gate and `press()` would STOP the turn — the exact thing
  owner Q1 forbids. The gate now reads the same current action `press()` uses.
- **`toolSummary` returns `{label, subtitle, output}`** — `trailing` and `tone`
  are Slice 3's (the row that draws them); adding them unused now would be
  untested surface. Subtitle "one line" is left to `numberOfLines={2}` (as
  today) so the string stays exactly the TUI's (parity).
- **B4 inline code: `codeBackground` prop, not a `code` token.** There is no
  token before Slice 1, and the planned light `code` (`#F2F2F7`) equals today's
  page background (assistant rows) and the dark one (`#1C1C1E`) today's `card`
  (user bubble) — either would re-hide it until Slice 3 changes the surfaces.
  Code blocks had the same `card`-in-`card` problem and get the same fix.
- **The parity test loads `render-lines.ts` by a computed path.** A static
  import pulls the TUI's terminal modules (`marked-terminal`, …) into
  `tsc -p apps/mobile`, which fails; `transcript-parity.test.ts` imports only
  `state.ts`, which does not.
- **Flow 23's B1 observable** is the tap reaching `composer-send` with the
  keyboard UP (flow 07 needed `hideKeyboard` because the tap hit a key), plus a
  `takeScreenshot` of both states — not a `maestro hierarchy` bounds check
  (Maestro's JS has no hierarchy access).

**NOT verified (simulator).** `bun run e2e:mobile` and `xcrun simctl` need an
approval this non-interactive session cannot give, so: flow 23 was neither shown
red on the old build nor green on the new one; the `<bug>-before/-after.png` and
light/dark screenshots under `.tentacle/tmp/mobile-ui/slice-0/` were not taken;
the Japanese-keyboard IME check and `submitBehavior` on RN 0.88/iOS were not
observed. To verify: `E2E_ONLY_FLOWS=23-composer-keyboard bun run e2e:mobile
--ios 18` (and `--ios 26`) on this branch (green expected) and on `fcd9138f`
with only the flow added (red expected at the `turn-running` wait), then the
full e2e run for the other flows (flow 07's `hideKeyboard` is still valid).

**Gate:** `bun run typecheck` clean · `bun run lint` 0 errors/0 warnings
(1377 files) · `bun test` 9946 pass, 4 skip (all opt-in: k8s, docker ×2,
slow socket), 0 fail.

### Slices 1–2 — tokens + primitives, Computers + Pair

*— claude-opus-5-5, 2026-11-14*

**Load-bearing check, re-run first (holds).** `ComputersScreen.tsx:1-18`,
`PairScreen.tsx:1-15` and `scanner.tsx:1-15` are still dumb renderers over
`computer-rows.ts` / `pairing-flow.ts` / `camera-access.ts` + `scan-session.ts`;
the restyle changed no view-model, and every existing test stayed green
unchanged (`bun test apps/mobile`: 935 pass after both slices).

**As built, in order.**
1. `src/theme.ts` — `Palette` grows to the mockups' table (`bg page card sheet
   fill code codeOnSheet label sec sep sepChat sepSheet accent accentFill
   onAccent tint green orange red warnBg warnText glass glassBorder
   shadowOpacity camera cameraAccent kw com add* del* dash switchOff`); the 7 old
   names are aliases built FROM the new tokens (`withAliases`), so unrestyled
   screens already show the new values. Plus `typography`, `radius`, `size`,
   `space`, `MONO`, `DENSE_FONT_SCALE`.
2. `test/theme.test.ts` (66) — WCAG ≥ 4.5 for `label/sec/accent` on
   `bg/card/page/fill/sheet/code`, both modes, plus accent-on-tint,
   onAccent-on-accentFill, status/warn/diff/syntax pairs; aliases equal their
   tokens; `code ≠ fill` (B4 stays fixed once bubbles move to `fill`).
3. `src/ui/` — `Icon`, `GlassButton`, `ScreenHeader`, `GroupedCard`, `Row`,
   `SectionHeader`, `StatusDot`, `Pill`, `Banner`, `EmptyState`, `Sheet`, and
   two not in the plan's list: `PillButton` (the Sheet's 50 pt buttons, also
   needed by Pair now and Lock later) and `ActionSheet` (Owner Q5's menu).
4. `src/computer-status.ts` (+ `test/computer-status.test.ts`, 10) —
   `computerStatus(row)` → `{tone, text, detail?, pairAgain}`, `menuActions(row)`,
   `sasGroups(sas)`.
5. `ComputersScreen.tsx` — large title + glass Settings (`open-settings`) and
   accent "+" (`computers-add`); per computer a 20/25 header (device icon,
   `StatusDot`, short status) with a "…" (`computer-menu-<id>`), a 26 pt card with
   the project row (`computer-<id>`, dashed/dimmed tile when not ok, the honest
   reason under it keeping `computer-state-<id>-<state>`), an inline "Pair again"
   row for attention states (`computer-pair-again-<id>`); the bottom "Pair a
   computer" card (`computers-pair-card`) + hint; errors as `Banner`
   (`computers-error`). Long-press or "…" opens the in-app `ActionSheet`
   (`computer-menu-pair-again-<id>`, `computer-remove-<id>`), which turns into the
   Remove confirmation in place (`computer-remove-confirm/yes/cancel-<id>`).
6. `PairScreen.tsx` + `scanner.tsx` — large-title intake: a hero card (Scan as
   the primary pill, `pair-scan`), camera problems as a `Banner`
   (`pair-camera-<card>`, `pair-camera-settings`), "Or paste the line it prints"
   card (`pair-paste-input`, `pair-paste-submit`). The live camera covers the
   screen (`pair-scanner`) with the viewfinder (240 pt, accent corners — drawn in
   `scanner.tsx`) and a dark glass Cancel (`pair-scan-close`). review /
   connecting / compare / done / failed render in a bottom `Sheet`; compare shows
   the SAS in two mono 40/48 `fill` boxes, a waiting row and "Codes don't match"
   (`pair-cancel`). Every testID kept; the scanner block keeps the exact
   `scanner === undefined || view.stage !== "intake"` gate the wiring test pins.
7. `App.tsx` — `Computers` and `Pair` get `headerShown: false` (Pair's back is
   the screen's glass Cancel, `pair-back`, only when the stack can go back);
   `ComputersRoute` holds the menu state next to `removing`.
8. `e2e/flows/16-remove-computer.yaml` — taps `computer-menu-<id>` before
   `computer-remove-<id>` (Owner Q5: "the tests are updated to open the menu
   first"). Flow 15 unchanged (Pair again stays visible on the row).
9. `changelog.d/mobile-ui-polish.changed.md`.

**Red before green (pasted).** `computer-status` against a stub reproducing
today's screen (Pair again only when `row.action === "pair-again"`, status text =
the long reason, SAS one string):
```
(fail) a computer that answered is Online, green, with no detail line
(fail) an unreachable one is Offline (ring) … Expected: "Offline"  Received: "dial failed"
(fail) revoked: needs attention … Expected: "attention"  Received: "offline"
(fail) maybe-reset / broken: … Expected: "attention"  Received: "offline"
(fail) every state has a non-empty short status word … Expected: not ""
(fail) menuActions … every row can be paired again or removed
(fail) sasGroups > six digits split in two groups of three
(fail) sasGroups > an already-grouped code is regrouped the same way
 1 pass  9 fail
```
The contrast test is new coverage of new values; its non-vacuity is the plan's
mutation below.

**Mutations (each run, then reverted from a scratch copy; suite green after):**
| Mutation | Caught by |
|---|---|
| light `sec` → `#AEAEB2` (the plan's named one) | 6 `sec on … ≥ 4.5:1` (light) |
| `computerStatus.pairAgain` → `row.action === "pair-again"` (today's rule) | "revoked: … offers Pair again inline" |
| `sasGroups` splits 2/4 | both 6-digit `sasGroups` cases |
| PairScreen scanner gate without `view.stage !== "intake"` | `scan-session-wiring` "mounts it ONLY at the intake" |

**Drift from Implementation (and why).**
- **Native add-ons NOT installed (BLOCKED, Slice 1 `package.json` step).**
  `expo-symbols`, `expo-haptics`, `expo-clipboard`, `expo-blur` need a registry
  fetch (`npm view` / `bun add` were refused: this session cannot approve network
  commands) and a dev-client rebuild. So `Icon` draws the chrome glyphs (chevrons,
  plus, xmark, ellipsis, checkmark, arrow up, stop) from views and the rest from
  system-font glyphs, behind the one `IconName` = SF Symbol name API — swapping in
  `<SymbolView>` is a change to `Icon.tsx` alone. `GlassButton` uses the
  translucent `glass` colours (the owner's named fallback for blur-off). **To
  finish:** `cd apps/mobile && bunx expo install expo-symbols expo-haptics
  expo-clipboard expo-blur`, then wire `SymbolView` in `Icon.tsx` and `BlurView`
  in `GlassButton.tsx`, and rebuild the dev client.
- **`type` → `typography`.** `import { type, … }` reads as a type-only import
  modifier to humans and some tooling (Babel/Metro); same table, other name.
- **Mono family = `Menlo`.** No simulator screenshot was possible to test
  `ui-monospace`; RN on iOS does not resolve that CSS alias, and Menlo is what
  the app already used.
- **`computerStatus` returns `detail` and `pairAgain` too, plus `menuActions`.**
  The short word ("Online") replaces the long reason in the header, so the reason
  needs its own field (it keeps the `computer-state-*` testID); the inline-Pair-
  again and menu decisions belong in the pure module, not the component (§7).
- **A `revoked` row now shows "Pair again" inline.** Before, the screen offered
  it only for `action === "pair-again"`, so a revoked row had only Remove — while
  `computer-rows.ts:12-16` says every such state offers Pair again and flow 15
  asserts `computer-pair-again-<id>` on a revoked row (by reading, that flow could
  not have passed; not run). `computerStatus.pairAgain` = every attention state.
- **Menu and confirmation are an in-app `ActionSheet`, not `ActionSheetIOS` /
  `Alert`** — same reason as the existing in-app confirmation (no testIDs for
  XCUITest under the new architecture); it is drawn as an iOS action sheet. One
  `Modal` stays mounted while the menu becomes the confirmation (no present-
  while-dismissing). The menu offers Pair again for every computer (a re-pair
  keeps the id, Q7).
- **Remove's wording** is a title "Remove '<name>'?" plus a body without
  backticks (they showed literally).
- **No "Code found" chip, "seen 2 h ago", "direct/relay" or trailing "1
  running"/"Idle" pill** — the row has none of those facts (no invented data);
  the device-name field stays on the review sheet (it is entered before
  connecting; the mockup's single sheet merges two stages the flow keeps apart).
- **`may-still-ask`** is now part of the failure banner's body (the
  `pair-may-still-ask` testID moves to that text; no flow asserts it).

**NOT verified (simulator).** No screenshots under
`/Users/gmeghnag/tentacle/.tentacle/tmp/mobile-ui/slice-1/` / `slice-2/` and no
e2e run (`xcrun simctl` / `bun run e2e:mobile` need approvals this session cannot
give), so the visual gate (Fable review vs the mockups, light + dark) is still
open, as are flows 15/16 and the pairing flows on the new layout. To verify:
`E2E_ONLY_FLOWS=15-revoked,16-remove-computer,12-pair-declined,13-pair-expired,20-camera-close
bun run e2e:mobile --ios 18`, then the screenshot pass.

**Gate:** `bun run typecheck` clean · `bun run lint` 0 errors/0 warnings
(1393 files) · `bun test` 10022 pass, 4 skip (opt-in), 0 fail. No schema change
(no `protocol.json` regen, no `protocol.d/` note).

### Fix round 1

*— claude-opus-5-5, 2026-11-14*

Scope: the two MEDIUM findings of "Slices 1–2 — adversarial review". Neither is
a code defect: both need access this session does not have. **No code was
changed.**

- **Finding 1 (Unicode icons, no `expo-blur`) — BLOCKED, not fixed.**
  `npm view expo-symbols@58 version` → "This command requires approval" (refused).
  None of `expo-{symbols,blur,haptics,clipboard}` is in
  `~/.bun/install/cache`, so no offline install is possible. Wiring `SymbolView`
  / `BlurView` without the packages cannot typecheck, and a guessed-API shim
  would be invented code (EXECUTOR-BRIEF). To unblock, someone with network
  access runs: `cd apps/mobile && bunx expo install expo-symbols expo-haptics
  expo-clipboard expo-blur`, then the `Icon.tsx` / `GlassButton.tsx` swap
  (both behind their existing APIs), then a dev-client rebuild.
- **Finding 2 (no screenshots / e2e on the new layout) — BLOCKED, not fixed.**
  `xcrun simctl list devices booted` → "This command requires approval"
  (refused). `.tentacle/tmp/mobile-ui/` has no PNGs. Still needed:
  `E2E_ONLY_FLOWS=15-revoked,16-remove-computer,12-pair-declined,13-pair-expired,20-camera-close
  bun run e2e:mobile --ios 18`, then light/dark screenshots into
  `.tentacle/tmp/mobile-ui/slice-1|slice-2/` and the Fable visual review.

**Red/green, mutations:** none. No fix was made, so there was nothing to turn
red and then green, or to mutation-check.

**Gate (unchanged tree, re-run):** `bunx tsc --noEmit` clean · `bun run lint`
1393 files, 0 issues · `bun test` 10022 pass, 4 skip (opt-in), 0 fail.

### Fix round 1 (after review round 3)

*— claude-opus-5-5, 2026-11-15*

Scope: the two MEDIUMs of "Slices 1–2 — adversarial review, round 3". This
session had registry access (`npm view expo-symbols@58 version` → 58.0.0–58.0.5)
and a booted simulator (`xcrun simctl list devices booted` → iPhone 17 Pro,
iOS 26.5). The e2e runner was still refused.

- **Finding 1 (Unicode icons, no blur) — FIXED (code); not seen on a device yet.**
  - `apps/mobile/package.json` + `bun.lock`: `bunx expo install expo-symbols expo-blur`
    → `expo-symbols ~58.0.5`, `expo-blur ~58.0.6` (SDK 58 pins).
  - `apps/mobile/src/ui/Icon.tsx`: the whole stroke/glyph renderer (with the
    `GLYPH` table `☰ ▭ ⌨ …`) is replaced by `<SymbolView name={name} tintColor size weight>`.
    The `IconName` union and `IconProps` are unchanged, so no caller changed. `IconName`
    now has to fit `SFSymbol`, so a misspelt name fails `tsc -p apps/mobile` (it passes).
    The fallback for non-iOS platforms is an empty box of the same size, not a glyph.
  - `apps/mobile/src/ui/GlassButton.tsx`: a `BlurView` (`systemUltraThinMaterial`,
    or `…Dark` with `onDark`, intensity 60) clipped to the circle, then the `glass`
    tint as an overlay above it. The shadow stays on the unclipped `Pressable`.
  - `expo-haptics` / `expo-clipboard` are not installed. No code uses them yet;
    they belong to the slice that adds Copy/haptics (Owner Q4).
  - Still Unicode, but on screens that are not restyled yet (later slices):
    `SettingsScreen.tsx:86` `✓` and `ComposeBar.tsx:137,172,177` `⏳ 🖼 ⚠ ◷`.
  - **Regression test** `apps/mobile/test/icon-glass-wiring.test.ts`, which pins
    the wiring from the source (the `.tsx` files cannot be imported by Bun). It checks:
    both packages are dependencies; `Icon` imports `SymbolView` and passes
    `name={name}`; `GlassButton` imports and renders `BlurView`; and no
    non-comment line of `Icon`/`GlassButton`/`ScreenHeader`/`ComputersScreen`/`PairScreen`
    contains a pictograph (U+2190–U+2BFF, U+1F000–U+1FAFF).
    - **RED** on the pre-fix tree: `0 pass · 5 fail`, every failure on its property
      assertion (`expo-symbols`/`expo-blur` undefined, no `SymbolView`/`BlurView`,
      glyph hits such as `"checkmark.circle": "✓"`).
    - **GREEN** after the fix: `5 pass · 0 fail`.
    - One test bug was found and fixed: the glyph scan flagged a `/** 123456 → 123 456 */`
      doc comment in `PairScreen.tsx`. The comment filter now also skips `/*` lines.
  - **Mutations** (the original files were copied to `.tentacle/tmp/mobile-ui-polish/`
    and put back for each run; afterwards each restored file was `cmp`-identical to the fix):

    | Mutation | Result |
    |---|---|
    | M1: the old glyph `Icon.tsx` | `3 pass · 2 fail`: "`Icon` renders a `SymbolView`…", "no restyled surface draws a Unicode glyph…" |
    | M2: the old `GlassButton.tsx` (no blur) | `4 pass · 1 fail`: "`GlassButton` puts a `BlurView` behind its content" |

- **Finding 2 (no simulator evidence) — BLOCKED, not fixed.**
  `E2E_ONLY_FLOWS=15-revoked,16-remove-computer,12-pair-declined,13-pair-expired,20-camera-close bun run e2e:mobile --ios 26`
  → "This command requires approval" (refused, both with and without output
  redirection). Screenshots of the build currently installed on the simulator would
  show the pre-fix app: the new native modules need a rebuild, and the runner does
  that rebuild (a Release build). So no PNGs were taken.
  - Still needed: that command (plus `--ios 18`) approved, then light/dark
    screenshots into `.tentacle/tmp/mobile-ui/slice-1|slice-2/`, then the Fable
    visual review.
  - On device this run also proves that `SymbolView`/`BlurView` render at all
    (the source-level test cannot).

**Gate:** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile` clean · `bun run lint` 1394 files,
0 issues · `bun test` 10027 pass, 4 skip (opt-in), 0 fail.

### Fix round 2

*— claude-opus-5-5, 2026-11-15*

Scope: the latest Review ("Round 2", after review round 3). Finding 1 was FIXED
there. Its only open item is MEDIUM finding 2. **No code was changed.**

- **Finding 2 (no simulator evidence) — BLOCKED, not fixed.** A simulator is
  booted (`xcrun simctl list devices booted` → iPhone 17 Pro, iOS 26.5).
  `E2E_ONLY_FLOWS=15-revoked,16-remove-computer,12-pair-declined,13-pair-expired,20-camera-close bun run e2e:mobile --ios 26`
  → "This command requires approval" (refused). The command was not retried in
  another form (§0). No screenshots were taken. The installed build predates
  `expo-symbols`/`expo-blur`, and only the runner rebuilds it, so screenshots
  now would show the old app and prove nothing. `.tentacle/tmp/mobile-ui/slice-2/`
  is still empty, and `slice-1/` does not exist.
  - Still needed (owner/orchestrator): approve that command, plus `--ios 18`.
    Then take light/dark screenshots into `.tentacle/tmp/mobile-ui/slice-1|slice-2/`
    and run the Fable visual review.

**Red/green, mutations:** none. No fix was made, so there was nothing to turn
red, then green, or to mutate.

**Gate (unchanged tree):** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile` clean ·
`bun run lint` 1394 files, 0 issues · `bun test` 10027 pass, 4 skip (opt-in), 0 fail.

### Fix round 3

*— claude-opus-5-5, 2026-11-15*

Scope: Review "Round 3". It has one open item, MEDIUM finding 2. It has no
HIGH item. **No code was changed.**

- **Finding 2 (no simulator evidence) — BLOCKED, not fixed.** A simulator is
  still booted (iPhone 17 Pro, iOS 26.5). I ran
  `E2E_ONLY_FLOWS=15-revoked,16-remove-computer,12-pair-declined,13-pair-expired,20-camera-close bun run e2e:mobile --ios 26`
  once. The harness answered "This command requires approval" (refused). I did
  not retry it in another form (§0). There are no screenshots and no flow
  results, for the same reason as Fix round 2: only the runner rebuilds the
  client with `expo-symbols`/`expo-blur`.
  - Unblock (owner/orchestrator): approve that command and its `--ios 18` twin.
    Then take light/dark screenshots and run the Fable visual review. Another
    executor round cannot close this.

**Red/green, mutations:** none. No fix was made, so there was nothing to make
red, then green, or to mutate.

**Gate (unchanged tree):** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile` clean ·
`bun run lint` 1394 files, 0 issues · `bun test` 10027 pass, 4 skip (opt-in), 0 fail.

### Visual fix round 1

*— claude-opus-5-5, 2026-11-15*

Scope: `.tentacle/tmp/mobile-ui/slice-2/visual-review-1.md` (verdict REVISE).

- **Blocking 1–2 (no slice-2 screenshots) — BLOCKED, not fixed.**
  `bun run e2e:mobile --ios 26` was refused again with "This command requires
  approval". I tried it twice: once with the output redirected to a log, which
  was refused because of a variable check, and once bare. No PNGs exist and no
  flows were written. To unblock, the owner approves that command (or
  allowlists `Bash(bun run e2e:mobile:*)`), and then the executor follows the
  screenshot recipe at the end of Review.
- **Side note (Lock screen reads as a draft) — fixed in code, not yet seen on a
  device.** This is the Slice 5 Lock item from Design 5, done early because the
  visual review asked for it:
  - `src/lock-screen.ts` (new, pure) holds the view-model:
    - the copy from the mockup;
    - the unlock label names only an **enrolled** sensor ("Unlock with Face
      ID" / "Unlock with Touch ID" on an iPhone SE class device / a plain
      "Unlock" when there is none or it is not known yet);
    - "Use Passcode" shows only next to a biometric button. It runs the same
      action, because `lock-auth.ts` already falls back to the passcode in the
      same call (Design 5's rule);
    - the footnote states the delay actually chosen (`immediately` / `5m` /
      `1h`). There is none for `never` or while the setting is still loading.
  - `src/lock-auth.ts`: `biometry()` reads `getEnrolledLevelAsync` +
    `supportedAuthenticationTypesAsync` and maps them through `biometryFrom`.
    Any failure gives `none`. It only sets the label and never takes part in a
    lock decision.
  - `src/screens/LockGate.tsx` renders the result:
    - a 96 pt accent app mark (22 radius, `lock.shield.fill`; the repo has no
      app-icon asset yet);
    - the title in `lockTitle` 28/34, the subtitle 16/22 `sec`;
    - at the bottom, a full-width 54 pt pill `accentFill` button with the
      sensor glyph, then "Use Passcode", then the footnote, all inside the safe
      areas;
    - the `no-passcode` notice is now a `Banner`.
    The Modal, the F14 hiding and every testID (`lock-screen`, `lock-unlock`,
    `lock-notice`) are unchanged. A new testID is added: `lock-passcode`.
  - `src/ui/Icon.tsx`: `touchid`, `lock.fill`, `lock.shield.fill`.
  - `App.tsx`: passes `biometry` into `LockGate`.

**Red/green, mutations:** `test/lock-screen.test.ts` (7 tests) was red before
the fix because the module did not exist. As a mutation, I removed the
enrolled-gate in `biometryFrom`: "sensor present but nothing enrolled" failed,
and it passed again after the revert.

**Gate:** `bunx tsc -p apps/mobile` clean · `bun run lint` 1396 files, 0 issues ·
`bun test apps/mobile` 947 pass, 0 fail.

**Unverified:** none of this has been seen on screen yet (the same block as
above). That includes the Lock screen in light, dark and on a small device.

### Slices 3–4 — Sessions + Conversation, Diff + Compose + Approval (+ owner bugs B4–B6)

*— claude-opus-5-5, 2026-11-15*

**Load-bearing check, re-run first (holds, with one exception found).**
`SessionsScreen.tsx`, `SessionScreen.tsx`, `TranscriptRow.tsx`, `Markdown.tsx`,
`DiffView.tsx`, `ComposeBar.tsx`, `PermissionSheet.tsx` were still dumb renderers
over `session-list.ts` / `session-view.ts` / `session-screen-controller.ts` /
`permission-sheet.ts`, and every existing test stayed green through the restyle.
The exception is not a screen: owner bug B4 was in the **wiring**
(`App.tsx` `composeWiring`), see below.

**B4 — a message sent from the phone did nothing. Root cause (two defects, both
reproduced).** The send path is `Composer` → `controller.press()`
(`session-screen-controller.ts` `press`) → `void compose.press(action)` →
`compose-controller.ts` `press`, which clears the field (F4) and then awaits
`basis()` → `handle.port.facts()` → `driver.enqueue` → `claim` → `deps.prompt`
(the screen's `promptWithRefs` → `RemoteSession.send` → `session/prompt`).
1. `App.tsx:333-341` (before) built `port` with
   `outboxSessionOf({ get sessionId() {…} } as never, …)`, so `facts()` threw
   `TypeError: session.snapshot is not a function` right after the field was
   cleared, and the `void` call dropped the rejection: nothing sent, nothing
   shown. (Also: `sessionHandle.current` was never assigned, so every
   `withSession` would have opened a SECOND handle of the same id, which replaces
   the client's stream listener and steals the screen's turn.)
2. Once sent, the person's own prompt was never drawn: `RemoteSession` does not
   re-deliver the sender's prompt (`remote-session.ts` "Our own prompt is already
   on screen"), and `session-feed.ts` `foldStream` folded only the stream.
   The fakes in `session-screen*.test.ts` yield a `user_message` themselves,
   which is why no test saw it.

Red, against a real in-process daemon with a laptop client attached
(`outbox-link.test.ts` "owner B4", the app's own handle wired as `App.tsx` does):
```
TypeError: session.snapshot is not a function.
      at facts (src/outbox-session.ts:75:39)
      at basis (src/compose-controller.ts:370:51)
      at press (src/compose-controller.ts:634:30)
(fail) owner B4: a send from the phone's composer … [9.33ms]
-- after fix 1 only --
expect(userRows(screen)).toContain("hello from the phone")   Received: [ "hi" ]
(fail) owner B4: … [3017.56ms]
```
Fix, in order:
1. `src/compose-handle.ts` (new) — `composeHandleOf({sessionId, client,
   session, mint})`, the `ComposeHandle` moved out of `App.tsx` (testable), built
   over the SCREEN's own attach handle; `port: outboxSessionOf(session, …)`.
   `ComposeWiring.handle` now takes that handle (`session-screen-controller.ts`
   passes `result.session` / `handle`); `App.tsx` calls `composeHandleOf`, and the
   dead `sessionHandle`/`withSession` are gone (no second handle is ever opened).
2. `src/session-feed.ts` — `ownTurn(turnId, events, prompt?)`: the own prompt is
   folded as a `user_message` at the stream's FIRST event (= the daemon took it;
   a refusal before the ack leaves no row and gives the words back), not doubled
   when that first event is the same `user_message` (a reset replay). Both
   `send` and `promptWithRefs` pass it. Red: `test/session-feed.test.ts` +4
   (2 fail before: "shows the prompt as a user row", "image-only prompt").
3. `src/compose-controller.ts` — `createdOrGiveBack`: a failure while creating
   the item for words already taken from the field (facts, store write) puts the
   words back with "that message was not sent — it is back in the field" (send
   and queue paths). Red: `session-screen-compose.test.ts` "owner B4: a send that
   fails AFTER the field cleared…" — `Expected: "my words"  Received: ""`.
Green: the real-daemon test proves `userTexts(daemon) == ["hi","hello from the
phone"]`, the screen's rows contain the user row, and the field is empty.

**B5 — autoscroll.** `src/follow.ts` (new, pure): `scrolled(state, metrics,
byPerson)`, `contentGrew`, `jumped`, `jumpPill`; only a DRAG (or its momentum)
stops following, reaching the bottom resumes it. `SessionScreen.tsx` feeds
`onScroll`/drag events and `onContentSizeChange`, performs `scrollToEnd`, shows a
glass "Jump to latest" / "New messages" pill (`jump-latest`), and a send/Return
resumes following. Red (stub = today, never follows): `test/follow.test.ts` 6/8
fail → 8/8 green.

**B6 — code blocks wrap.** `src/code-block.ts` (new, pure): `codeBlockView` →
per-line spans (a span across a newline is cut, scope kept; empty line = " ";
label = fence language or `code`). `src/ui/CodeBlock.tsx`: 34 pt header + the
lines in a horizontal `ScrollView`, one `Text` per line. `Markdown.tsx` routes
every fenced block through it. Red (stub = one wrapping run): 6/6 fail; the
wiring part of `test/code-block.test.ts` (source-level: horizontal ScrollView,
`view.lines.map`, no `flexShrink`/`flexWrap`, Markdown uses `<CodeBlock`) failed
with ENOENT until `CodeBlock.tsx` existed → 9/9 green.

**Slice 3 as built.**
- `src/session-groups.ts` (+ `test/session-groups.test.ts`, 7; red 7/7 on a
  stub): Running / Idle / Archived, the search filter (owner decision 2), the
  inline meta line. `SessionRow` gains `running` and `attached` (additive, from
  the entry).
- `SessionsScreen.tsx`: large title + glass back (`sessions-back`), search field
  (`sessions-search`), sections as `SectionHeader` + `GroupedCard` + `Row`
  (status dot, terminal icon, meta line, archived icon/dimmed), `Banner` for
  stale/error (`sessions-stale`, `sessions-error`, `sessions-retry`),
  `EmptyState` (mono `tentacle`, no backticks), "No matches". `section-active`
  now wraps Running+Idle (flow 02 unchanged).
- `src/tool-summary.ts` `toolMeta` (+4 tests, red 4/4 on a stub): tone + trailing
  (`+3 −5` / `denied` / duration). No exit code — `ToolResult` has none
  (`packages/core/src/tool.ts:48-70`), so none is invented.
- `src/chat-header.ts` (+ `test/chat-header.test.ts`, 4): the header's status word.
  New coverage written with the module (no stub red); non-vacuity by mutation M8.
- `src/ui/ToolRow.tsx`, `src/ui/CodeBlock.tsx`, `src/ui/Composer.tsx` (new).
- `TranscriptRow.tsx`: right-aligned `fill` bubble (77 %, radius 20, code on
  `code`), full-width answer, reasoning collapsed ("Thinking", chevron), tool as
  `ToolRow` with output opening below on `code` (`tool-<id>-output`), notices
  centred. `Markdown.tsx`: 16/23 text, `CodeBlock`, tables as a real grid
  (column-major, one-line cells, horizontal scroll).
- `SessionScreen.tsx`: compact `ScreenHeader` (glass back `session-back`, title,
  status dot + word), `page` background, `Banner` (kind → tone/icon table;
  `banner-<kind>`, `banner-retry`, `reopen` kept), `EmptyState`, `Composer`, B5.
  `turn-running`/`turn-idle` is now a zero-size observable (the
  `composer-filled` pattern); the visible cue is the header's "Running".
- `App.tsx`: `Sessions` and `Session` get `headerShown: false` (+ `onBack` when
  the stack can go back); the dialling placeholder has the same header.

**Slice 4 as built.**
- `DiffView.tsx`: a header (path, green `+n`, red `−m`, chevron) always on
  screen, carrying `diff-<callId>` (flow 08 asserts it without tapping); the
  hunks open on tap (`diff-<callId>-toggle`): hunk heading on `code`, two 30 pt
  gutters, sign column, `addBg`/`delBg` rows with `addText`/`delText`, horizontal
  scroll. No word highlights (`diff-view.ts` yields none).
- `ComposeBar.tsx`: notices as tinted rows with icons; the queue as a `fill`
  card "Queued · the agent reads these at its next step", clock rows, Take, and
  **Send now** as a 44 pt `accentFill` pill with `bolt.fill` (`composer-send-now`,
  moved here from the composer); `composer-queue` stays on the rows only (flows
  12–15 still wait for a real queued row). Chips: capsules with photo icon /
  spinner / warning + ×. `OutboxRows` untouched (Slice 5).
- `src/permission-sheet.ts` `optionStyle` + `labelRuns` (+7 tests, red 4 fail on
  a stub): allow once primary, allow always tinted, deny destructive, reply
  neutral + `bubble.left`, unknown id neutral (shown, never dropped); a label's
  paired backticks become a mono run (no literal `` ` `` on screen).
- `PermissionSheet.tsx`: native `pageSheet` kept; content scrolls
  (`keyboardShouldPersistTaps`), grabber, 44 pt `tint` tile + title 22 bold, the
  detail in a `codeOnSheet` box (mono 14), 50 pt answer pills with a REAL
  `disabled` during the age guard (`PillButton` only dims, so the sheet draws its
  own), reply field on `fill`, every testID kept.
- `src/ui/Icon.tsx`: `arrow.down`, `photo`, `hand.raised`.
- `changelog.d/mobile-ui-polish.fixed.md`: the existing bullet extended with
  B4–B6 (one file, one bullet).

**Mutations (each run, then restored from
`/Users/gmeghnag/tentacle/.tentacle/tmp/mobile-ui-polish/mut/`; `diff -rq` clean
after):**
| # | Mutation | Caught by |
|---|---|---|
| M1 | `compose-handle.ts` port back to `outboxSessionOf({ sessionId } as never, …)` | `outbox-link` "owner B4" (real daemon) |
| M2 | `session-feed.ts` never draws the own prompt | "owner B4" (real daemon) + 2 `session-feed` cases |
| M3 | `createdOrGiveBack` rethrows | `session-screen-compose` "owner B4: … gives the words back" (send) |
| M3b | queue path calls the creator unguarded | same test, queue iteration (`Received: ""`) |
| M4 | `follow.scrolled` lets the list's own scroll stop following | "the list's OWN scroll … never stops following" |
| M5 | `codeBlockView` does not split on `\n` | 5 `code-block` cases |
| M6 | unknown option id → `primary` | "an id this build does not know is drawn neutral" |
| M7 | Running needs `attached > 0` | "active rows split into Running and Idle" |
| M8 | `chatStatus`: link down does not win over running | "the link down wins over a running turn" |

**Drift from Implementation (and why).**
- **B4 needed a wiring + feed fix, not a restyle** (above). `ComposeWiring.handle`
  changed signature (takes the screen's handle); internal to the app.
- **Owner decision 3 (auto-accept switch, "Also asked on") — STOPPED.** The
  premise (a shared, wire-level auto-accept) is false; the plan is corrected
  inline under *Owner decisions*. Nothing built; needs an owner decision and its
  own task.
- **Not built, no data or no package:** the code block's Copy button and the
  haptics (`expo-clipboard` / `expo-haptics` not installed; adding them needs a
  native rebuild — same block as Slice 1); the Sessions subtitle
  "MacBook Pro · ~/path" (the route has only the name); "Thought for 4 s" (a
  reasoning row has no duration → "Thinking"); the running-tool row pinned above
  the composer with its own Stop pill and elapsed time (no controller `stop()`
  separate from `press()`, which queues when the field has text, and no ticking
  clock in the view-model — the composer's Stop stays the way to stop).
- **`OUTPUT_PREVIEW_LINES` 6 → 12**: the output now opens on tap in its own
  panel, so the first view of it shows more.
- **Diff collapsed by default**, with the testID on the always-visible header,
  instead of "keep the newest expanded" (the plan's fallback): satisfies flow 08
  without tapping.

**NOT verified (simulator).** No e2e run or screenshot was attempted in this
session (same block as earlier rounds: `bun run e2e:mobile` needs approval). In
particular unseen on device: B4 on a real `serve` + TUI (the real-daemon unit
test is the evidence), B5's follow/jump behaviour with real scroll events, B6's
horizontal scroll, the zero-size `turn-running` observable for XCUITest (same
pattern as `composer-filled`), flows 02/07/08/12–15 on the new layout. To verify:
`bun run e2e:mobile --ios 26` then the screenshot recipe below (Sessions,
Conversation with code/table/tool/diff, Compose with queue, Approval; light+dark).

**Gate:** `bun run typecheck` clean (root + `apps/mobile` + `apps/relay`) ·
`bun run lint` 1408 files, 0 issues · `bun test` 10079 pass, 4 skip (opt-in),
0 fail. No schema change (no `protocol.json` regen, no `protocol.d/` note).

### Slices 5–6 — Offline + Lock + Settings, polish (+ owner feedback #3)

*— claude-opus-5-5, 2026-11-15*

**Load-bearing check, re-run first (holds).** `ComposeBar.tsx`,
`OutboxDecisionSheet.tsx`, `LockGate.tsx`, `SettingsScreen.tsx`, `Markdown.tsx`,
`CodeBlock.tsx` were still renderers over precomputed values (`session-view.ts`
`OutboxRowView`, `lock-screen.ts`, the Settings props, `markdown.ts`). The only
branching found in a component was `OutboxRows`' state → glyph chain (`◷ ↑ ⏳ ⚠`);
it moved to a pure module (below). Every existing test stayed green unchanged
except the one that pinned the aliases this slice removes (`theme.test.ts`, see
drift).

**B7 — `&#x27;` inside a highlighted code block. Repro first**
(`.tentacle/tmp/mobile-ui-polish/b7/repro.ts`, on this branch before the fix):
```
$ bun .tentacle/tmp/mobile-ui-polish/b7/repro.ts
parse: {"kind":"blocks","blocks":[{"kind":"code","lang":"python","text":"print('a < b' if x > 1 and y & z else \"q\")"}]}
python ["print(&#x27;a < b&#x27; if x > 1 and y & z else \"q\")"]
bash ["print(&#x27;a < b&#x27; if x > 1 and y & z else \"q\")"]
ts ["print(&#x27;a < b&#x27; if x > 1 and y & z else \"q\")"]
null ["print('a < b' if x > 1 and y & z else \"q\")"]
```
Root cause: highlight.js `escapeHTML` escapes `'` as `&#x27;`
(`apps/mobile/node_modules/highlight.js/lib/core.js:61-67`), and
`highlight.ts` `unescapeHtml` undid only `&lt; &gt; &quot; &amp;` — so only a
block that was HIGHLIGHTED (a known fence language) showed it. Red
(`test/code-block.test.ts` "quotes, <, > and & show as themselves…", 5 languages
incl. none): `Received "print(&#x27;a < b&#x27; …"` → fix `highlight.ts:198-211`
(`&#x27;` → `'`, `&amp;` still last, so a literal `&amp;` stays `&amp;`) → green.

**Owner feedback #3, as built.**
- *Code blocks* (`src/ui/CodeBlock.tsx`): the mockup's header — label in mono
  12 `sec` + a 44×34 **Copy** button (`code-<i>-copy`; `expo-clipboard`, success
  haptic, a 1.5 s checkmark); the lines scroll inside a view inset 12 pt on BOTH
  sides (the screenshot's lines ran into the block's right edge) with the native
  horizontal indicator on; 12 pt bottom padding (mockup `padding: 0 12px 12px`).
- *Font*: the mono family is now **SF Mono** (`MONO = "ui-monospace"`,
  `theme.ts`): RN 0.88 maps that name to `UIFontDescriptorSystemDesignMonospaced`
  (`react-native/…/RCTFontUtils.mm:375-404`), the mockups' own family. Measured
  on the owner's screenshot, the code was already ≈ 12 pt (45 chars over 952 px
  at 3×); what read as "~17pt" was Menlo's width/weight, so the size stays the
  mockup's 12.5/19 and the face changes.
- *Inline code* (`code-block.ts` `inlineCodeLook`, `Markdown.tsx`): a nested
  `Text`'s background fills the whole line height and takes no padding/radius —
  the "strip". A span ≤ 24 chars with no newline is now an inline **View chip**
  (mono 14, padding 1/5, radius 5, `code` fill — the mockup's CSS), shifted 4 pt
  to sit on the baseline; a longer span is a mono **run with no background**
  that wraps like text (a chip cannot break across lines).
- *Typography/spacing*: body was already 16/23; the missing piece was the
  rhythm — `Markdown` had **no gap between blocks** (the screenshot's
  "Esecuzione:" sat flush under the code block). Blocks now have the mockup's
  10 pt gap.
- *Header "…"* (`SessionScreen.tsx`, `src/session-menu.ts` pure + 5 tests, red 4/5
  on a stub; inline-code tests red 2/4 on a stub): a glass `ellipsis`
  button (`session-menu`) opening an action sheet with phone-local actions only —
  **Copy last answer** / **Copy conversation** (each offered only when it has
  text; "Nothing to copy yet" otherwise). Computer-side actions stay out (owner
  decision 2).

**Slice 5 as built.**
- `src/outbox-look.ts` (new, pure, + `test/outbox-look.test.ts` 8; red 3/7 on a
  stub before `back-to-draft` was added): per row a cue (`none` / `spinner` /
  `attention`), a status line, and the "…" options button only when `decide`;
  the group caption "Waiting for network · sent on reconnect if nothing changed"
  while any row waits.
- `ComposeBar.tsx` `OutboxRows`: right-aligned **dashed** bubbles (1.5 pt `dash`,
  radius 20, 16/22; orange border when a decision is needed), the 44 pt "…"
  button (`outbox-options-<id>`), status with spinner/warning icon, the caption.
  `outbox-row-<id>-<state>` kept on the bubble (still the tap target).
  `BarView.outbox` is now `OutboxRowView[]` (it was a looser copy).
- `OutboxDecisionSheet.tsx`: native `pageSheet` (was a full-screen `Modal`) with
  the shared `Sheet` (grabber, title 22, the why as subtitle), the message as a
  dashed bubble, and 50 pt `PillButton`s — Send primary, Queue as steer
  secondary, Edit neutral, Discard destructive, Not now neutral. Every testID kept.
- `SettingsScreen.tsx`: `ScreenHeader` large title + glass back
  (`settings-back`), `SectionHeader` + 26 pt `GroupedCard` + 44 pt `Row`s, SF
  Symbol checkmark, the pending "Unlock to apply" in `sec` (the hard-coded
  `#8E8E93` is gone), notices/errors as `Banner`. `App.tsx`: Settings gets
  `headerShown: false` + `onBack`.
- **Lock**: nothing to do — `LockGate.tsx`'s `LockScreen` was already restyled to
  the mockup in "Visual fix round 1" (96 pt mark, 28/34 title, 54 pt Face ID
  button, footnote, `Banner` for no-passcode).
- Offline header subtitle: stays `Offline` — no last-sync time exists in the
  view-model (the plan's own fallback; nothing invented).

**Slice 6 as built.**
- *Haptics* (`expo-haptics`): `src/haptic-rules.ts` (pure, + 4 tests, red 3/4 on a
  stub): press → light (send/queue/send-later), firm (Stop), none (no-op); Return
  through the SAME `returnKeyAction` gate, so it never "feels" like a Stop; turn
  end (running → idle) → success. `src/haptics.ts` plays it, errors ignored.
  Wired in `SessionScreen.tsx` (composer press/Return, the turn-end effect) and on
  Copy.
- *LayoutAnimation* (`src/ui/animate.ts`, ease-in-out): tool output, reasoning
  and diff open/close (`TranscriptRow.tsx`, `DiffView.tsx`); the queue/outbox/
  chips when `src/compose-motion.ts` `composeRowsMoved` (pure, + 4 tests, red 3/4
  on a stub) says a row arrived, left or changed state — never on a streamed
  token alone.
- *Dark-mode pass*: a scan of every `<Text>` tag in `apps/mobile`
  (`.tentacle/tmp/mobile-ui-polish/dark/scan.ts`) — the 16 without their own
  colour all inherit one from a coloured parent `Text` (mono runs, inline
  markdown, diff counts), are the always-dark camera overlay (`scanner.tsx`), or
  are the zero-size observables. Hard-coded colours left: shadows, the action
  sheet backdrop, the camera chrome — all scheme-independent.
- *Aliases removed* (`theme.ts`): `Palette` is the tokens only; the last three
  uses (`App.tsx`) now read `bg`/`red`.
- *Screenshot flow*: `e2e/flows/24-ui-shots.yaml` — Computers, Settings,
  Sessions, the Conversation after a `SHOWCASE` prompt, the "…" menu, each
  asserted by its own ids then `takeScreenshot`; its seed is the mock model's
  `SHOWCASE_MD` (`e2e/mock-model.ts`) on its own session (`SHOTS_ID`,
  `COMPOSE_SESSION_VARS`). `test/ui-shots-seed.test.ts` (3) reads the seed through
  the app's own parser: block order (so `code-2` is the code block), both inline
  looks present, B7's characters literal.
- `package.json` + `bun.lock`: `expo-haptics ~58.0.8`, `expo-clipboard ~58.0.4`
  (`bunx expo install`; both need a dev-client/Release rebuild).
- Changelog: `changelog.d/mobile-ui-polish.changed.md` rewritten to "a new look on
  every screen" (one bullet, the whole restyle); `…fixed.md`'s bullet gains B7.

**Mutations** (`.tentacle/tmp/mobile-ui-polish/mut56/mutate.ts`: back up, mutate,
run, restore; each restore byte-checked, `git status` unchanged after):
| # | Mutation | Caught by |
|---|---|---|
| M1 | `unescapeHtml` drops `&#x27;` | `code-block` B7 + `ui-shots-seed` B7 |
| M2 | `inlineCodeLook` always `chip` | 2 `code-block` cases + `ui-shots-seed` "both looks" |
| M3 | `pressHaptic`: Return skips `returnKeyAction` | "Return: … never for a Stop" |
| M4 | `composeRowsMoved` ignores row state | "a row changes state (queued → sending)" |
| M5 | outbox options from `state`, not `decide` | "the options button follows `decide`" |
| M6 | copy-last takes the FIRST answer | "copy the last answer: the newest …" |
| M7 | an alias name back on the palette | "no pre-restyle alias name is left" |

**Drift from Implementation (and why).**
- `theme.test.ts` "theme aliases (until Slice 6)" pinned the aliases; Slice 6
  removes them, so it became the inverse guard ("no alias name is left").
- The screenshot flow is `24-ui-shots.yaml` (numbered, in `FLOWS`) instead of
  `ui-shots.yaml`: the sandbox allows `bun run e2e:mobile --ios 26` but not an
  `E2E_ONLY_FLOWS=` prefix, so only a flow in the default list ever runs; it sits
  before the lock flows (which change the lock setting).
- The screenshot walk covers Computers, Settings, Sessions, Conversation (code,
  chip/run inline code, table, list) and the "…" menu. NOT in it: Pair, Diff,
  Compose-with-queue, Approval, Offline-with-outbox, Lock — each needs daemon-side
  state a single flow cannot stage without the hooks those flows already use
  (07/08/12/16/18); their own flows run in the same suite.
- Inline code is two looks (chip / run), not one: a padded chip cannot wrap, so
  a long span keeps the mono face without a background.
- The session "…" menu holds copy actions only (no rename/archive/new): those
  need the computer (owner decision 2's separate task).
- Not built: the running-tool row pinned above the composer with its own Stop
  (Slices 3–4 drift, unchanged), "Offline · synced HH:MM" (no data).

**Simulator (attempted, NOT verified).** `bun run e2e:mobile --ios 26` ran:
the build installed (the new `expo-haptics`/`expo-clipboard` compiled; no build
error), then `01-shell` and `02-session-list` both failed at the SAME step, inside
the shared `_unlock` subflow, before any restyled screen:
`[Failed] 01-shell (21s) (Assertion is false: id: lock-screen is visible)` (same
line for 02). Its screenshot
(`.tentacle/tmp/e2e-mobile/1794704822773/ios26/01-shell/…/step-011-assertCondition-lock-screen.png`)
shows the app's lock cover drawn under the system **Face ID** sheet: the sheet is
up and Maestro sees no `lock-screen` id. Every flow goes through `_unlock`, so the
run was stopped after two (§0: same failure, no new information). This slice did
not touch `LockGate.tsx`, `_unlock.yaml` or the Face ID scripts. Not diagnosed:
whether it is the simulator's enrolment state (`faceid-enroll.js`) or the earlier
rounds' lock changes. **No screenshots were taken**, so the restyle, the inline
chip's baseline shift, SF Mono, the Copy button and flow 24 are unseen on a
device. To verify: fix `_unlock` on iOS 26, then `bun run e2e:mobile --ios 26`
(flow 24's `24-*.png` in its output dir), light and dark.

**Gate:** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile` clean ·
`bunx tsc -p apps/relay` clean · `bun run lint` 1419 files, 0 issues ·
`bun test` 10108 pass, 4 skip (opt-in), 0 fail. No schema change (no
`protocol.json` regen, no `protocol.d/` note).

### Visual fix round 2 (slice 6, after `slice-6/visual-review-1.md`)

- **F2 dark mode:** the generated `ios/tentacle/Info.plist` had
  `UIUserInterfaceStyle = Light` (read, line 109–110) because `app.json` had no
  `userInterfaceStyle`; added `"userInterfaceStyle": "automatic"`. Guard in
  `theme.test.ts` (red on the old `app.json`, green now). Takes effect at the next
  prebuild (the harness prebuilds every run).
- **F1/F3 `_unlock` on iOS 26:** the system Face ID sheet hides the app, so the
  old "assert `lock-screen` visible, match, assert it gone" hung on the first step
  and would pass the last one vacuously. `_unlock.yaml` now keys on the positive
  signal `app-content` (`LockGate`'s wrapper id once unlocked; `locked-content`,
  hidden, before): it re-posts `pearl.match` up to 8× until `app-content` is
  visible, then asserts `lock-screen` gone. `computers-list` is still asserted
  hidden first. Flows 18–20 still assert `lock-screen` visible directly and will
  hit the same sheet on iOS 26 — not changed here.
- **P1:** `pairingView` carries `submit: "empty" | "unparsed" | "ready"`
  (`pasteSubmit`, pure); Continue is disabled (`fill`, label at 0.5) when empty,
  neutral when unparsed (still pressable so the payload error explains why), tinted
  only when the line parses. `submit` on an empty field is now a no-op. Disabled
  `PillButton`s draw their content at 0.5 everywhere. Tests red on the old module.
- **P2:** new `ui/InlineMono.tsx` (label colour, 1 pt under the sentence), used on
  Pair and on the Computers empty hint.
- **P3:** both intake cards use `space.cardInner` (16).
- **P4:** body copy is the mockup's sentence.
- **P5 / all screenshots:** not taken — simulator commands need an approval this
  run did not have. Still owed: F1's full set light + dark, Lock unobstructed (F3),
  keyboard-up Pair (P5), iPad.

**Gate:** `bun test apps/mobile` 1024 pass, 0 fail · `bunx tsc -p apps/mobile`
clean · `bun run lint` 1420 files, 0 issues.

*— claude-opus-5-5, 2026-11-15*

### Fix round — the slice 6 walk on iOS 26 (orchestrator's order)

Each item red-first unless marked; then `bun run e2e:mobile --ios 26 --only
24-ui-shots,23-composer-keyboard,18-photos` until green.

1. **Harness `--only <flow,flow>`** (`e2e/run.ts` `parseArgs`/`selectedFlows`;
   the flag wins over `E2E_ONLY_FLOWS`, which still works; names checked before
   any build). Tests in `e2e-preflight.test.ts`. The first real run iterated the
   CHARACTERS of a path: `main` already bound `flows` to the flows dir. Renamed
   to `runFlows`, plus a guard test (one binding, looped over).
2. **Pair: paste field and Continue under the keyboard** (the walk failed at
   `pair-review`). The avoiding view shrank the screen but the list kept its
   offset. New pure `src/field-reveal.ts` (focus/blur, `keyboardDidShow/Hide`,
   content resize → reveal); `PairScreen` scrolls to the end on a reveal (the
   paste card is last). Content resize matters: the pasted line wraps and pushes
   Continue down again. Tests: `field-reveal.test.ts`. On device:
   `02-pair-keyboard-*.png`, and flow 24 now asserts `pair-paste-submit`
   visible with the keyboard up before it taps it.
3. **Light + dark in one walk**: new `appearance` hook (`simctl ui <udid>
   appearance light|dark`, `appearanceOf`), `flows/appearance.js`, and
   `_shot.yaml` (light shot → dark → dark shot → light). Flow 24 inlines
   `_pair`'s steps so the Pair stages are shot too. Tests: `e2e-appearance.test.ts`.
4. **`turn-idle` missing on iOS 26** (flows 23, 24): the 0×0 `fontSize: 0`
   observable was absent from the accessibility tree (hierarchy dump: neither
   id). Now 1×1, absolute, transparent (`SessionScreen` `observable`, same for
   `composer-filled` in `ui/Composer.tsx`, whose text was also `""`). *No unit
   test (RN layout); proven only on device:* run 3 got past it, run 5 green.
5. **B8 — "at most 5 photos" before the library opens** (owner, iOS 18.3.1).
   `compose-controller.ts` passed `pickRoom(chips)` (the ROOM, 5 when empty) to
   `pickFromLibrary(taken)` / `takePhoto(taken)`, so the limit was `5 - 5 = 0`
   and the adapter refused before presenting the picker. Now `counted(chips)`.
   Test: `compose-controller.test.ts` "B8: the picker is told how many photos
   are TAKEN" (red: `library:5`). On device the picker now reads "Select up to
   5 photos." and flow 18 passes.
6. **Refused photo chips ~380 pt tall**: a `ScrollView`'s base style grows, so
   the horizontal chip row split the free height with the transcript.
   `ComposeBar` `chipRow: { flexGrow: 0 }`. Test: `compose-bar-layout.test.ts`
   (source guard).
7. **Flow/harness bugs (the flows were wrong, not the app):** flow 18 tapped
   `Library` (button is "Photo Library"; Maestro matches the whole text), named
   cells `PNG fixture` (iOS 26's PHPicker labels them "Photo, <date>, <time>"
   → the two newest cells, this run's `addmedia` pair) and `Add` (iOS 26:
   "Done"); the harness `serve` had images OFF (`model.images` has no env var;
   OpenAI-shaped default is no vision) → `harnessConfigText()` written to its
   `config.jsonc` before the first start, test in `e2e-preflight.test.ts`;
   `23/07/22-*.js` compared model prompts verbatim, but context awareness
   appends `\n\n[context: …]` → matched on the typed first line.

**Result:** `✓ 24-ui-shots (iOS 26)` `✓ 23-composer-keyboard (iOS 26)`
`✓ 18-photos (iOS 26)` — `PASS` (run 1794724072250). Screenshots (light and
dark, every screen of the walk) in `.tentacle/tmp/mobile-ui/slice-6/01-…09-*`,
plus `10/11-composer-keyboard-*` (flow 23, light only).
**Not done here:** the owner's qwen3.8 (vision) photo test against a real
`serve` (only the mock model's `saw 2 images` is proven); iOS 18 not run; 07
and 22 not re-run after their script fix.
**Gate:** `bun test apps/mobile` 1046 pass, 0 fail · `bunx tsc -p apps/mobile`
clean · `bun run lint` 1425 files, 0 issues.

*— claude-opus-5-5, 2026-11-15*

### Slice 7 — owner feedback #3 + B7 (STOPPED: no work left to plan; B8 verified only by unit test)

**Load-bearing check (holds):** `CodeBlock.tsx`, `Markdown.tsx` and
`SessionScreen.tsx` still render values that pure modules compute
(`code-block.ts`, `highlight.ts`, `session-menu.ts`).

**Contradiction, so I stopped here.** The doc has no Slice 7 plan.
Owner feedback #3 and B7 were already built in "Slices 5–6" (above):
`highlight.ts:208` decodes `&#x27;`, `CodeBlock.tsx` has the header and Copy
button, `code-block.ts` has `inlineCodeLook`, `theme.ts:170` sets
`MONO = "ui-monospace"`, and `session-menu.ts` backs the "…" menu. The owner
approved those screens on 2026-11-15 10:35. There was nothing left to build and
no flow list to screenshot, so I made **no code change and wrote no changelog
fragment**: `mobile-ui-polish.changed.md` and `.fixed.md` already cover this.

**Re-verified on this branch (64431d79):** `code-block`, `session-menu`,
`ui-shots-seed` and `compose-controller` tests: 55 pass, 0 fail.
Mutations (`.tentacle/tmp/mobile-ui-polish/s7/mut.ts`; each file restored and
byte-checked; `git status` clean afterwards):
| # | Mutation | Result |
|---|---|---|
| M1 | `unescapeHtml` drops `&#x27;` (B7) | 2 fail (`code-block` + `ui-shots-seed`) |
| M2 | `pickFromLibrary(pickRoom(chips))` (B8 reverted) | 1 fail (`compose-controller` B8) |

**Not done: the owner's qwen3.8 (vision) photo test.** It needs a real
`tentacle serve` on the user's DEFAULT profile, driven from the simulator. The
sandbox refused even a read of the user's tentacle config. No plan step stages
a real model in the e2e harness either: the harness uses `mock-model.ts`. B8 is
proven by the red-first unit test and flow 18 (mock model, `saw 2 images`), NOT
against qwen3.8. **Decision needed:** approve running a real `serve` (default
profile) alongside the simulator, or let the owner run the test on device.

**Gate:** `bunx tsc --noEmit` clean. `bun run lint`: 1497 files, no issues.
`bun test`: the first run had 10806 pass, 5 skip, 1 fail. The rerun had
0 fail. The failure is flaky and I did not identify it. This slice changes only
this doc. No schema change.

*— claude-opus-5-5, 2026-11-15*

## Review

### Slice 0 — adversarial review (fresh context)

**Verdict: APPROVE (code), merge gated on finding 1.** Scope: `git diff main...HEAD`, Slice 0 only.

**Gate (re-run):** `bun test` 9946 pass · 4 skip (opt-in) · 0 fail · `bun run typecheck` clean · `bun run lint` 1377 files, 0 issues. Touched files: 102 pass / 0 fail.

**Findings (HIGH/MEDIUM):**
1. **MEDIUM — B1/B2 have no executed evidence.** `apps/mobile/e2e/flows/23-composer-keyboard.yaml` was never run red (on `fcd9138f`) or green, and no `slice-0/*-before/after.png` exist. The B1 fix (`SessionScreen.tsx` `measureInWindow` → `keyboardVerticalOffset`, `composerBottomPadding`) and B2 (`submitBehavior="submit"` on a `multiline` input, RN 0.88/iOS) are correct by reading but unobserved. Failure scenario: if the onLayout-time `measureInWindow` y or `submitBehavior` behaves differently on device, the owner's two reported bugs ship unfixed with a green unit suite. Precondition for merge: `E2E_ONLY_FLOWS=23-composer-keyboard bun run e2e:mobile --ios 18` (+ `--ios 26`) green on HEAD and red on `fcd9138f`, plus the screenshots (§9, the orchestrator's screenshot rule).

**Mutations (each run, then reverted; tree byte-identical via `cmp` to a scratch copy, `git status` clean):**
| Mutation | Caught by |
|---|---|
| `markdown.ts` codespan without `decodeEntities` | "a code span shows the characters" |
| `pressReturn` gate → `kind !== "none"` (lets `stop` through) | "Return on an empty field while a turn runs never stops it" |
| `ansi.ts` OSC: drop the `ESC \` terminator | "OSC hyperlinks are removed, BEL- and ST-terminated" |

**Attacks tried:**
- *Parity drift*: `tool-summary.ts` `subtitleOf` vs `render-lines.ts:562-610` — identical case for case; every built-in tool name in `packages/tools/src` is covered (unknown/MCP tools show raw args, same as the TUI — by design).
- *Entity decoding end-to-end* (scratch `md.ts`): link text, link href with `&` (href stays raw, not double-escaped), heading, table cell with code span, quote, list, `\*`/`\<` escapes, bold/em/del — all show the literal characters.
- *Return races*: gate reads `view()` at call time like `press()` (`session-screen-controller.ts:637-643`), so a stale rendered `send` cannot become a Stop — holds; pinned by the mutation above.
- *B4 coverage*: every `Text` in `Markdown.tsx` has a colour either directly or inherited from a coloured paragraph/heading/code/table parent; inline code in the user bubble uses `groupedBackground` ≠ `card`.
- *§7*: no protocol/persistence/daemon touch; decisions in pure modules (`returnKeyAction`, `composerBottomPadding`, `toolSummary`, `decodeEntities`, `stripAnsi`); the screen holds only keyboard/measure presentation state. Holds.
- *e2e wiring*: `KEYBOARD_ID` is created by `spawnFlow`'s `COMPOSE_SESSION_VARS` path (`e2e/run.ts:726-733`); `e2e-flows.test.ts` passes.

**Below threshold (not blocking):** `SafeAreaProvider` without `initialMetrics={initialWindowMetrics}` renders nothing for the first frame (`SafeAreaContext.tsx:105-111`); `TranscriptRow`/`SessionScreen` wiring has no render test (repo convention: no RN component harness), so only the pure helpers are pinned.

**Executor behaviour:** honest — the drift (measureInWindow, controller-side gate, `codeBackground`) is justified and the controller-side gate is a real improvement over the plan; the unrun simulator work is stated plainly rather than claimed.

*— claude-opus-5-5, 2026-11-14* (same model as the executor/planner, fresh context only — shared blind spots possible)

**Screenshots (orchestrator, binding):** every slice ends by saving simulator screenshots of each screen it touched, light AND dark, as PNG under `/Users/gmeghnag/tentacle/.tentacle/tmp/mobile-ui/slice-<n>/` (`<screen>-light.png`, `<screen>-dark.png`; Slice 0 also `<bug>-before.png`/`-after.png`). A fresh Fable visual review gates the merge of every slice against the mockups and the quality bar.

### Slices 1–2 — adversarial review (fresh context)

**Verdict: REQUEST-CHANGES (merge-gating, no code defect found in the logic).** Scope: `git diff main...HEAD`, Slices 1–2 only.

**Gate (re-run):** touched tests (`theme`, `computer-status`, `scan-session-wiring`, `e2e-flows`) 103 pass / 0 fail · `bun run typecheck` clean · `bun run lint` 1393 files, 0 issues. Full `bun test` not re-run (Execution reports 10022 pass / 4 opt-in skip).

**Findings (HIGH/MEDIUM):**
1. **MEDIUM — Owner decision 4 not met: icons are still Unicode glyphs.** `apps/mobile/src/ui/Icon.tsx:48-66` draws `☰ ▭ ⌨ ⌗ ☺ ⊘ ◷ ⚡︎ ⌫ …` for every non-chrome icon; the Computers screen uses three of them on every view (`slider.horizontal.3`, `laptopcomputer`, `folder`, `qrcode.viewfinder`: `ComputersScreen.tsx`). Failure scenario: the owner opens the app and sees the same "strange characters" class they reported (B3, Context) and the Design's "replaces every emoji/Unicode glyph" is false; no `expo-blur` either. Executor flagged it as BLOCKED (network); merge needs `expo install expo-symbols expo-haptics expo-clipboard expo-blur` + `SymbolView`/`BlurView` wiring + dev-client rebuild.
2. **MEDIUM — no executed evidence for the restyle or the changed flow.** No screenshots in `.tentacle/tmp/mobile-ui/slice-1|slice-2/`, no Fable visual review (orchestrator's binding gate), and flow `16-remove-computer.yaml` (now taps `computer-menu-<id>` → in-app `Modal`) plus pairing flows 12/13/20 were never run on the new layout. Failure scenario: a Modal/XCUITest visibility or layout problem (e.g. Pair's sheet under the keyboard, `pair-back` in a scroll view) ships behind a green unit suite. Precondition: `E2E_ONLY_FLOWS=15-revoked,16-remove-computer,12-pair-declined,13-pair-expired,20-camera-close bun run e2e:mobile --ios 18` green, then the light/dark screenshot pass.

**Mutations (each run, then restored from a scratch copy; `git status` clean):**
| Mutation | Caught by |
|---|---|
| `computerStatus`: `unreachable` → `attention` tone | "an unreachable one is Offline (ring)…" |
| dark `accent` → `#0E7490` | 7 dark `accent on … ≥ 4.5:1` cases |

**Attacks tried:**
- *testID contract*: every `pair-*`/`computer-*`/`open-settings` id referenced by `e2e/flows` exists in the new screens; `pair-may-still-ask` moved to the Banner body (no flow asserts it). Holds.
- *Menu → confirmation*: `ComputersRoute` sets `menu=undefined` + `removing=row` in one batch, so the single `ActionSheet` `Modal` stays visible (no dismiss/present race); Pair again from the menu is a stack push, not a modal presentation. Holds.
- *`computer-state-<id>-<state>` render gate* now `status.detail !== undefined`: every non-ok row has a non-empty `status` (`computer-rows.ts:58,88`). Holds.
- *Alias regression on unrestyled screens*: aliases are built from the new tokens; `running`/`badgeText` = `accent`/`onAccent` (dark `#22D3EE` on `#00191F`, high contrast); Slice 0's B4 (`groupedBackground` ≠ `card`) still holds. Holds.
- *Failure dead end*: a `retry: "no"` failure on a root Pair screen has no button — same as `main`, not a regression.
- *§7*: no protocol/persistence/daemon touch; decisions (`computerStatus`, `menuActions`, `sasGroups`) in a pure tested module; screens render. Holds.

**Executor behaviour:** honest — the blocked add-ons and unrun simulator work are stated plainly; the `revoked` → inline "Pair again" drift is justified by `computer-rows.ts` and flow 15.

*— claude-opus-5-5, 2026-11-14* (same model as the executor, fresh context only — shared blind spots possible)

### Round 2

**Verdict: REQUEST-CHANGES (both findings still open; executor blocked, not at fault).** Scope: `git diff HEAD~1` = `docs/feat/mobile-ui-polish.md` only (+30 lines, "Fix round 1"); no file under `apps/` changed (`git diff HEAD~1 --quiet -- apps` ⇒ empty).

- **Finding 1 (Unicode icons, no `expo-blur`) — OPEN.** `Icon.tsx` still has the glyph table (`☰ ▭ ⌨` present); `apps/mobile/package.json` has none of `expo-{symbols,blur,haptics,clipboard}`. The doc's BLOCKED claim is consistent with the tree.
- **Finding 2 (no simulator evidence) — OPEN.** No PNG under `.tentacle/tmp/mobile-ui/`; flows 12/13/15/16/20 still unrun on the new layout.
- **Mutation:** not applicable. There is no new code or test to mutate; the round-1 mutations (computer-status, dark accent) still apply to an unchanged tree.
- **Regressions:** none possible from a docs-only diff. Gate: `bun run typecheck` clean · `bun run lint` 1393 files, 0 issues.
- **Executor behaviour:** honest. It changed no code and did not invent shims; it states the refused commands and the exact unblock steps. Unblocking needs the owner/orchestrator: network access for `bunx expo install …`, plus simulator approval for e2e and screenshots.

*— claude-opus-5-5, 2026-11-14* (same model family as the executor's doc author, fresh context only)

### Slices 1–2 — adversarial review, round 3 (fresh context)

**Verdict: REQUEST-CHANGES (merge-gating; no new code defect).** Scope: `git diff main...HEAD`, Slices 1–2.

**Gate (re-run):** touched tests (`theme`, `computer-status`, `scan-session-wiring`, `e2e-flows`) 103 pass / 0 fail · `bun run typecheck` clean · `bun run lint` 1393 files, 0 issues.

**Findings (HIGH/MEDIUM):**
1. **MEDIUM — still open: Owner decision 4 (SF Symbols) not met.** `apps/mobile/src/ui/Icon.tsx:48-50` still maps `slider.horizontal.3`/`folder`/`laptopcomputer` to `☰ ▭ ⌨`, shown on every Computers view (`ComputersScreen.tsx:99,147,193,224`); `apps/mobile/package.json` has no `expo-symbols`/`expo-blur`. Scenario: the owner sees the "strange characters" class they reported. Needs network for `bunx expo install …` + dev-client rebuild.
2. **MEDIUM — still open: no executed evidence.** `.tentacle/tmp/mobile-ui/slice-2/` (and `slice-0/`) exist but are empty; flows 12/13/15/16/20 unrun on the new layout (16 now goes through an in-app `Modal`, `ActionSheet.tsx:46`). Scenario: a Modal/XCUITest or keyboard-over-review-sheet (`PairScreen.tsx:249`, non-scroll `Sheet` with `pair-device-name`) problem ships behind a green unit suite.

**Mutation (restored from scratch copy; `git status` clean):** `computerStatus.pairAgain` → `tone !== "online"` ⇒ caught by "an unreachable one is Offline (ring)…".

**Attacks tried:** menu→Remove/Pair-again state handoff (`App.tsx:732-745`, one Modal stays mounted; Pair-again is a stack push and Pair's `Sheet` is not a Modal, so no present-while-dismissing) — holds; bad/duplicate QR decode under the full-screen scanner (`scanner.tsx:100-107` dispatches `scanned` → camera ends before the intake shows the failure) — holds; header safe-area with `headerShown: false` (`ScreenHeader.tsx:38-61`) — holds; §7: no protocol/persistence/daemon touch, decisions in `computer-status.ts` — holds.

**Executor behaviour:** honest; blockers stated, no invented shims.

*— claude-opus-5-5, 2026-11-15* (same model family as the planner/prior reviewers; executor was deepseek — fresh context only)

### Round 2

**Verdict: REQUEST-CHANGES (finding 1 fixed; finding 2 still open — executor blocked, not at fault).** Scope: `git diff HEAD~1` (`a4f82ce2`).

- **Finding 1 (Unicode icons, no blur) — FIXED.** `Icon.tsx:50-62` renders `<SymbolView name={name} …>`; the `GLYPH` table is gone; `GlassButton.tsx:66-81` puts a clipped `BlurView` under the `glass` tint; `package.json` pins `expo-symbols ~58.0.5`, `expo-blur ~58.0.6` (both present in `apps/mobile/node_modules`). Mutations (each restored from a scratch copy; `git status` clean after): `IconName` member `trash` → `trashx` ⇒ `tsc -p apps/mobile` fails at `Icon.tsx:53` (the `SFSymbol` typing claim holds); `<BlurView` → `<View` ⇒ `icon-glass-wiring` "puts a `BlurView` behind its content" fails (4 pass / 1 fail) and tsc fails. The test is source-level only: it cannot prove the native views render.
- **Finding 2 (no simulator evidence) — OPEN.** `.tentacle/tmp/mobile-ui/slice-2/` is empty and there is no `slice-1/`; flows 12/13/15/16/20 are unrun. This now matters more, because two new native modules need a dev-client/Release rebuild before `SymbolView`/`BlurView` can be seen at all.
- **Regressions:** none found. Callers are unchanged (same `IconName`/`IconProps`); the shadow stays on the unclipped `Pressable`; the glyph regex (U+2190–U+2BFF, U+1F000+) does not catch `…`/`–`/curly quotes in the restyled files. Still Unicode on unrestyled screens (`SettingsScreen.tsx`, `ComposeBar.tsx`) — later slices, as the doc says.
- **Gate:** `bun run typecheck` clean · `bun run lint` 1394 files, 0 issues · `icon-glass-wiring` + `theme` + `computer-status` 81 pass / 0 fail.
- **Executor behaviour:** honest. It fixed what network access allowed, showed red→green plus two mutations, and stated plainly that the refused e2e/screenshot step is still owed.

*— claude-opus-5-5, 2026-11-15* (fresh context; executor was a different model)

### Round 3

**Verdict: REQUEST-CHANGES (finding 2 still open; executor blocked, not at fault).** Scope: `git diff HEAD~1` (`d0c4349d`), which touches only `docs/feat/mobile-ui-polish.md` (+25, "Fix round 2"); `git diff HEAD~1 --quiet -- apps` shows no change.

- **Finding 2 (no simulator evidence) — OPEN.** There is no PNG in `.tentacle/tmp/mobile-ui/slice-2/`, and `slice-1/` does not exist. The only file there is `screens.log`, a tool-call transcript from another session that started an `e2e-mobile` iOS 26 build. It holds no flow result and no screenshot, so it is not evidence. Flows 12/13/15/16/20 have not run, and `SymbolView`/`BlurView` have not been seen rendering on a rebuilt client.
- **Finding 1:** still fixed (no code changed since Round 2).
- **Mutation:** not applicable. The diff is docs-only, so there is no new code or test to mutate.
- **Regressions:** none possible from a docs-only diff. Gate: `bun run typecheck` clean · `bun run lint` 1394 files, 0 issues.
- **Executor behaviour:** honest. It changed no code, did not retry the refused command in another form (§0), and states the exact unblock steps: approve `E2E_ONLY_FLOWS=… bun run e2e:mobile --ios 26` (and `--ios 18`), then take light/dark screenshots and run the Fable visual review. This needs the owner or orchestrator, not another executor round.

*— claude-opus-5-5, 2026-11-15* (fresh context; executor was a different model)

### Round 4

**Verdict: REQUEST-CHANGES.** Scope: `git diff HEAD~1` (`0dc925e9`). It changes no code (`git diff HEAD~1 --quiet -- apps packages` reports nothing). It adds "Fix round 3" to this doc and 12 untracked-tool artefacts.

1. **MEDIUM (new regression) — stray Playwright artefacts committed at the repo root.** `.playwright-mcp/` holds `p1.png` (2.8 MB), `now.png`, `p2.png`, `probe-*.png`, `v1.png` and five `page-*.yml` snapshots. One snapshot is an HTTP 404 page; the others are empty. That is about 3.8 MB of binaries unrelated to the task, and `.gitignore` has no `playwright` entry. Failure scenario: merging puts them permanently into `main`'s history (a later delete does not shrink the repo), and they look like task evidence when they are not. Fix: remove `.playwright-mcp/` from the branch, and add it to `.gitignore` (or keep such output under `.tentacle/tmp/`, §6).
2. **MEDIUM — finding 2 (no simulator evidence) still OPEN.** No PNG under `.tentacle/tmp/mobile-ui/slice-1|slice-2/` (only another session's `screens.log`). The committed `.playwright-mcp` images are browser probes, not simulator screenshots of the app or e2e flow results. Owner/orchestrator approval of the e2e run is still required.

- **Mutation:** not applicable. No code or test changed.
- **Gate:** `bun run typecheck` clean · `bun run lint` 1394 files, 0 issues.
- **Executor behaviour:** the doc is honest about the block. But the commit swept in unrelated tool output, which suggests `git add -A` without checking the staged files.

*— claude-opus-5-5, 2026-11-15* (fresh context; executor was a different model)

**How to take the screenshots (orchestrator, 2026-11-15 — the sandbox allows exactly these):** build + install with `bun run e2e:mobile --ios 26` (no env prefix: `E2E_ONLY_FLOWS=…` is refused); then write small Maestro flows under `/Users/gmeghnag/tentacle/.tentacle/tmp/mobile-ui/flows/` that navigate to each screen and `takeScreenshot` into `.tentacle/tmp/mobile-ui/slice-<n>/`, run them with `maestro test <file>`, switch appearance with `xcrun simctl ui booted appearance dark|light`. Never a browser/Playwright, never files at the repo root.

#### Owner bug report #2 (2026-11-15 ~01:15, real iPhone, build of 876a7cc7) — MUST be fixed in slices 3+4 (Conversation/Compose), each with a red-first test, and checked by the review

- **B4 (HIGH):** a message sent from the phone does NOTHING: it does not appear in the conversation and the model does not receive it (session on a local `tentacle serve`, connected TUI on the laptop). Trace the send path (composer → client `session/prompt` or enqueue → daemon) end to end with file:line; prove the fix with a test that the daemon receives the prompt and the transcript shows the user row.
- **B5:** the view does not follow the streaming text: the user has to scroll down by hand. Auto-scroll to the bottom while new content arrives, unless the user has scrolled up (then show a "jump to latest" pill).
- **B6:** code blocks must NOT wrap: keep each line intact and scroll the block horizontally (monospace, horizontal ScrollView), as in the Conversation mockup.
*— claude-opus-5-5 (orchestrator), 2026-11-15*

## Review — Slices 3–4 (fresh context)

**Verdict: APPROVE (code); no HIGH/MEDIUM finding.** Scope: `git diff main...HEAD` (c9d70aca), Slices 3–4 + B4–B6 only.

**Gate (re-run):** `bun run typecheck` clean (root + mobile + relay) · `bun run lint` 1408 files, 0 issues · touched tests (9 files) 120 pass / 0 fail. Full `bun test` not re-run here.

**Attacks tried:**
1. *B4 give-back ⇒ double send?* `createdOrGiveBack` (`compose-controller.ts:433`) returns the words if `driver.enqueue` throws; a duplicate would need the item to be in the store as well. `enqueue` (`outbox-driver.ts:406-414`) → `save` → `store.setItems` → `write` (`outbox-store.ts:302`) → `persist`, which catches and returns `false` (`:290-299`): the store never throws, so only `basis()`/`createItem` can throw, and both run before an item exists. Holds. (The doc's "the store write throws" is not a real path; harmless.)
2. *Own row drawn AND words given back?* The row is drawn at the first streamed event (`session-feed.ts` `drawPrompt`); words come back only when `!streamed` (`session-screen-controller.ts:520-536`). These two cannot both happen. Holds.
3. *Second handle / §7 one session path:* `composeHandleOf` uses the screen's own `RemoteSession`; `handle()` is gated on `phase === "open" && handle !== null` (`session-screen-controller.ts:278`); no frame is built in the app. Holds.
4. *B5 stale closure / throttle:* `followRef` + `dragging` refs, `scrollEventThrottle={32}` (`SessionScreen.tsx:134-170, 292-306`). Holds (not checked on a device).
5. *Approval sheet:* `sheet.answer(optionId)` is unchanged, the guard is a real `disabled`, unknown ids are drawn neutral. Single broker untouched. Holds.

**Mutations (mine; restored from `.tentacle/tmp/mobile-ui-polish/rev34/`, `git status` clean):** dedupe of a re-delivered prompt removed → 3 fail (`session-feed` "not doubled", `session-screen` own/foreign identical rows, send folds); `contentGrew` always scrolls → `follow` "scrolls UP … pill shows" fails. The executor's M1–M8 were not re-run.

**LOW (not gating):** `contentGrew` treats any size change as growth. While scrolled up, a shrink (collapsing a tool output) shows "New messages". While following, expanding a row jumps to the end.

**Executor behaviour:** stopped on the false auto-accept premise instead of building a fake one (good). Every gap that needs a simulator is listed as NOT verified. The commit is titled "exec (deepseek)" but the Execution section is signed claude-opus-5-5, so the attribution should be reconciled. This reviewer is the same model family as that signature: shared blind spots possible. Simulator/e2e (flows 02/07/08/12–15, B5/B6 on a device) remain unverified.

*— claude-opus-5-5, 2026-11-15*

#### Owner feedback #3 (2026-11-15 01:43, real iPhone, build c8b4dc3c)

It works now ("ora funziona"); "UI migliorata ma si potrebbe fare ancora meglio". Screenshot: `/Users/gmeghnag/tentacle/.tentacle/tmp/mobile-ui/owner-shots/conversation-code-0143.jpeg`. Fix in slices 5+6 and check in the final visual gate:

- **B7 (bug):** HTML entities shown raw inside code blocks: `&#x27;` instead of `'` (escaped twice or never unescaped). Red-first test with a code block containing quotes, <, > and &.
- **Code blocks:** font too big (looks ~17pt; mockup 12.5px mono / 19px line height); the block runs to the right screen edge with no inset/radius on that side. Add the mockup header row (language/file name + copy button), consistent 16px side insets, rounded corners on both sides, a scroll indicator.
- **Inline code** (e.g. `python3 dirscanner.py [path] [-n N] [--hidden]`): renders as a big separate highlighted strip that wraps with a ragged background. It must be inline mono ~14px with small padding + radius, wrapping like text.
- **Typography/spacing:** body text and code feel oversized; follow the mockup scale (16/23 body, 13 secondary) and consistent paragraph spacing.
- **Header:** add the mockup's right-side session menu button (glass "…") to balance the back button.

*— claude-opus-5-5 (orchestrator), 2026-11-15*


#### Simulator Face ID — the exact unlock recipe for screenshot agents (orchestrator, 2026-11-15 02:20; supersedes the earlier hint)

Agents writing their own Maestro flows got stuck on the lock screen: the repo's `_unlock.yaml` calls `runScript` hooks (`faceid-enroll.js`, `faceid-match.js`) that only work while `bun run e2e:mobile` runs its hook server (`MAESTRO_HOOKS`). Outside the harness, unlock with the same notifications the harness posts (`apps/mobile/e2e/run.ts:344-363`), all allowed commands:

1. Enroll once per simulator boot (two commits — `-s` alone is not enough):
   `xcrun simctl spawn booted notifyutil -s com.apple.BiometricKit.enrollmentChanged 1` then
   `xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit.enrollmentChanged`
2. Launch the app WITHOUT clearing state: `xcrun simctl launch booted so.tentacle.app` (or a Maestro `launchApp` with `clearState: false`).
3. Wait until the Face ID prompt is UP (the `lock-screen` id is visible, ~2–3 s), THEN match:
   `xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.pearl.match`
   (`pearl` = Face ID; NOT `fingerTouch` — that is Touch ID and does nothing here. A match posted before the prompt is up resolves nothing: post it again.)
4. Then run the screenshot flows against the unlocked app (no `clearState`, no relaunch). The lock screen itself is screenshotted BEFORE step 3.

*— claude-opus-5-5 (orchestrator), 2026-11-15*

## Review — Slices 5–6 (fresh context)

**Verdict: PASS (code); no HIGH/MEDIUM finding.** Scope: `git diff main...HEAD` (17b79078), Slices 5–6 + B7 only.

**Gate (re-run):** `bun run typecheck` clean (root, mobile, relay). `bun run lint`: 1419 files, 0 issues. Touched tests (outbox-look, haptic-rules, compose-motion, session-menu, code-block, theme, ui-shots-seed): 104 pass, 0 fail. Full `bun test` was not re-run here.

**Attacks tried:**
1. *§7 logic in components:* checked the outbox glyph chain (now `outbox-look.ts`), the haptic choice (`haptic-rules.ts`), the animate decision (`compose-motion.ts`) and the menu text (`session-menu.ts`). All four are pure and tested. What is left in components is presentation: the Copy "copied" timer, and the subscribe wrapper that calls `animateNextLayout`. Holds.
2. *B7 ordering:* `unescapeHtml` (`highlight.ts:203-209`) decodes `&#x27;` before `&amp;`. A source `&#x27;` that highlight.js escapes to `&amp;#x27;` therefore comes back literal, not as `'`. Holds.
3. *Settings back / disabled export:* `export-logs` without `onPress` is a `Row` with `disabled` and keeps its testID (`Row.tsx:73-79`). Flow 21 is unaffected. `settings-back` is wired only when `canGoBack()`. Holds.
4. *Outbox testIDs:* `outbox-row-<id>-<state>` stays on the tap target, still `disabled={!decide}`. Every decision-sheet testID is kept. The `pageSheet` swipe-down goes through `onRequestClose`, so `deciding` is cleared. Holds (not checked on a device).
5. *Haptic on Return for Stop:* goes through `returnKeyAction` → null. Holds.

**Mutations (mine; `.tentacle/tmp/mobile-ui-polish/rev56/mut.ts`, each restore byte-checked, `git status` clean):** caption on `sending` instead of `waiting` → 1 fail. `turnEndHaptic` without `wasRunning` → 1 fail. Menu dropping user rows → 2 fail. `compose-motion` ignoring `sendNow` → 1 fail. `unescapeHtml` without `&amp;` → 1 fail. The executor's M1–M7 were not re-run.

**LOW (not gating):**
- `turnEndHaptic` plays *success* for every turn end, including `error` and `interrupted` (`transcript.ts:213-219`; `haptic-rules.ts:33`). This matches the plan's wording, but a failed turn "feels" successful.
- The press haptic reads the rendered `state.view.composer.action` (`SessionScreen.tsx:425,430`), while the controller acts on the current one. In a one-frame race the feel can differ from the act. The act itself is unaffected.
- `animateNextLayout` in the subscribe callback animates the whole next commit, transcript growth included, whenever a compose row moves. This may fight follow-scroll (B5). Unverified on a device.

**Unverified:** every restyle in these slices is unseen on a device (`_unlock` failed on iOS 26; no screenshots). The visual gate remains merge-blocking, as the Execution says. The executor stopped after the same `_unlock` failure appeared twice and reported it honestly (good). This reviewer is the same model family as the Execution's signature, so shared blind spots are possible.

*— claude-opus-5-5, 2026-11-15*


#### Owner request (2026-11-15 02:35): test photo ATTACHMENTS end to end — part of the final check of slices 5+6

Send a photo from the app (simulator: a Photos sample image via the composer's image button / the 13c photo input) to a session on a local `tentacle serve` that runs the **DEFAULT profile — the local qwen3.8 model, which has vision** (NOT `--profile deepseek`: DeepSeek has no vision and the daemon answers "images are off"). Screenshot the composer with the attached thumbnail, the sent user row with the image, and the model's reply describing it (light + dark), into the final screenshot folder. If anything in the attachment path fails (picker, downscale, upload, the row, the model never seeing the image), it is a bug of this task: reproduce, fix with a red-first test, re-shoot.
*— claude-opus-5-5 (orchestrator), 2026-11-15*


#### Owner bug B8 (2026-11-15 02:40, real iPhone 12 Pro, iOS 18.3.1, build c8b4dc3c)

Attaching a photo shows "a message carries at most 5 photos" (refused) — the owner was attaching normally, well under 5. The message comes from `apps/mobile/src/compose-controller.ts:348` (`added.refused > 0`), with the caps in `compose-chips.ts:52/78`, `photo-input.ts:78`, `photo-source.ts:164` (`MAX_ATTACHMENTS_PER_MESSAGE = 5`, `packages/protocol/src/attachment.ts:29`). Suspects to PROVE with a red-first test: the refused count computed against the wrong list (e.g. picks counted twice, failed/old chips still counted, the picker's selection limit not set so iOS returns more than the room, or `pickRoom([])` vs the real chips). Fix it, then verify the full attachment path in the qwen3.8 (vision) test above.
*— claude-opus-5-5 (orchestrator), 2026-11-15*

**B8 precise repro (owner, 02:45):** tap "Add photo" → "Photo library" → the error "a message carries at most 5 photos" appears IMMEDIATELY: the photo library never opens, no photo was selected, the composer had 0 photos. So the refusal is computed BEFORE/INSTEAD OF presenting the picker (e.g. a room of 0 from a wrong count, a selectionLimit of 0 making the picker refuse, a permission/launch failure mapped to "refused", or the picker result for a non-opened library treated as over-cap). Start from the tap handler for "Photo library" (photo-source.ts / photo-input.ts / compose-controller.ts pickRoom) on iOS 18.3.1.

#### Owner visual approval (2026-11-15 10:35)

The owner reviewed the 25 simulator screenshots of slices 5+6 (light/dark) and approved them ("vanno bene"), overriding the Fable gate verdict REVISE (round 2). Merged by the orchestrator on that approval.


#### Owner bugs B9 + B10 (2026-11-15 11:03, real iPhone, build b97ff97b) — part of Slice 7

Screenshot: `/Users/gmeghnag/tentacle/.tentacle/tmp/mobile-ui/owner-shots/photo-row-1103.png`. The photo DID reach the daemon and the model (serve log: `media_message` with `IMG_4854.jpg`, Qwen3.8 described it correctly), but the app shows it wrong:
- **B9 (ordering, HIGH):** the user's message with the photo ("Cosa vedi?") is rendered BELOW the assistant's reply to it — the transcript puts the `media_message` row after the reply (ordering by kind/arrival instead of the log order/seq?). Prove with a red-first test on the transcript projection (a `media_message` followed by the reply must render in log order) and fix.
- **B10 (thumbnail):** the photo shows as a grey placeholder "[image: IMG_4854.jpg]" instead of the picture. Show the real thumbnail: the phone's own just-sent photo from the outbox/local cache at once, and for history/other devices fetch it from the daemon by attachment id (the existing attachment read path; size-capped, cached), with a loading and an error state; tap opens it full screen.
*— claude-opus-5-5 (orchestrator), 2026-11-15*
