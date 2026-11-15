# feat/mobile-chrome — iPhone chrome restyle: thin header, soft dark palette, sessions drawer, minimal rows, activity sheet

> **Status:** implementation — **Implementation APPROVED by the owner (2026-11-15)** (all Owner questions A–F answered; see Owner answers at the end of Implementation)
> **Branch:** `feat/mobile-chrome`
> **Size:** L as a whole — split into 10 slices, each S or M with its own Size · Blast · Suited (see Slices) · **Blast:** cross-module (every screen reads the changed tokens/primitives, the Session screen's navigation changes, the phone starts consuming the existing `subagents`/`jobs` updates, one new phone-local setting; no protocol, persistence-of-sessions or §7 invariant moved) · **Suited:** per slice; mandatory fresh-context Review at the end + a visual review of Maestro screenshots against mockup row D
> **Changelog:** `changelog.d/mobile-chrome.changed.md` — one bullet (header, dark palette, sessions drawer, banded lists); `changelog.d/mobile-activity.added.md` — one bullet (sub-agents and shell jobs on the iPhone: Activity sheet, live steps, message, stop; optional floating button)

## Context

*— claude-opus-5-5, 2026-11-15*

The owner reviewed the iPhone app live on 2026-11-15 (screenshots and their
words in `.tentacle/tmp/mobile-chrome/`, `ITEM4.md`) and asked for five style
changes that form ONE visual system, so they are one design task (the bugs of
the same session — items 1, 2, 3, 5, 6: rename dialog, composer height,
scroll, "Sending…" label — are `fix/mobile-chat-glitches`, planned and fixed
in parallel, and are **not** planned here):

- **(4) Header icons** (`header-tentacle.jpg`): the session header's back
  chevron and "…" sit in 44 pt filled glass circles (`ui/GlassButton.tsx:43`,
  semibold glyphs `ui/Icon.tsx:68`) — "too big and heavy". Wanted: thin line
  glyphs, no filled circle, ~22 pt, lighter stroke, title + subtitle centred,
  a small status ring instead of a heavy element.
- **(7) Dark background** (`background-reference.png`): the dark palette is
  pure black (`theme.ts:108-110`, `page`/`bg` `#000000`, `label` `#FFFFFF`) —
  "il nero dello sfondo è troppo nero, dà fastidio". Wanted: a warm dark grey
  in the `#1f1f1e`–`#262624` range, surfaces a step lighter, off-white text,
  hairline separators. Light mode unchanged.
- **(8) Sessions drawer** (`drawer-reference.png`): the left header button
  becomes a hamburger opening a drawer from the left over a dimmed screen:
  recent sessions (icon + title), the current one highlighted, a primary
  "New session" at the bottom, the computer/user at bottom-left — fitted to
  our model (computers → sessions, archived, state dots, rename; which
  computer the drawer lists).
- **(9) Grouped cards** (`session-info-current.png`): the Session info sheet —
  and by the same rule every grouped-card screen (Settings, sheets, Computers,
  Sessions) — uses 26 pt inset cards (`ui/GroupedCard.tsx:21-25`,
  `theme.ts:198`) inside a 38 pt sheet (`theme.ts:199`) with uppercase section
  headers (`ui/SectionHeader.tsx:28`). On 390 pt the text column is ~326 pt and
  label and value truncate together; "a jumble of little boxes". The owner's
  intent: aesthetic minimalism, beautiful and user-friendly — full-width rows,
  hairline separators, little or no radius, quiet section labels, right-aligned
  values that never truncate the label, generous vertical rhythm, fewer
  containers.

- **(11) Sub-agents on the iPhone** (`subagent-stuck.png`, owner 16:42–16:50):
  today a sub-agent is a teal tool block ("Agent · Task lungo in background")
  and nothing else — once it runs in the background it cannot be found,
  followed, messaged or stopped from the phone. The phone's reducer drops
  every sub-agent frame on purpose (`apps/mobile/src/transcript.ts:414-419`:
  "the phone has no nested panel and no job dock in this slice").
  Requirement (16:45): the entry point is **one tap from the session screen**
  (a header control with the live count, or a bottom handle) — not inside
  Session info — and it is ONE **"activity" surface** that will also host
  background shell **jobs** and **cron** jobs: sub-agents now, the others
  later, same sheet, grouped by kind, running first. Plus (16:50, "idea
  folle"): a **draggable floating button** with the count that snaps to an
  edge, as variant F2 next to the header badge F1, with honest pros/cons and
  an interactive mockup. The owner's vocabulary and decisions are
  `docs/eval/subagent-live.md` (`sa-N`, type `explore`/`general`,
  background, report, 5 recent steps — Q17; one background list for
  sub-agents AND shell jobs — Q15; a finished item leaves the TUI list at
  once — `docs/feat/subagent-panel.md:362,381` P5).

Constraints: owner rule — style choices are decided on **mockups** before any
code; take only proportions/weight/feel from the reference app, never its
branding, glyphs or wordmark; tokens stay the single source (`theme.ts:1-8`);
logic in pure modules, components only render (AGENTS §7).

**Mockups:** `.tentacle/tmp/mobile-chrome/mockups/index.html` (self-contained,
light/dark toggle, iPhone 12 Pro 390×844 frames, the app's real tokens):
(A) header — today vs A1/A2; (B) dark palette — today vs B1/B2/B3 on the real
session screen; (C) drawer — C1 (computer at top) vs C2 (computer at
bottom-left) + C2 with the computer menu open; (D) the owner's CHOSEN
combination A1 + B1 + C1 + E2 + F1 in light and dark (updated after the
answers); (E) Session info today vs E1/E2 + Settings in E1;
(F) activity — F1 header badge, F2 draggable floating button (interactive:
drag, edge snap, tap opens the sheet), the Activity sheet (sub-agents live,
shell jobs + scheduled greyed), a sub-agent's detail running (live steps,
your messages with "read", Message + Stop) and finished (report).

**Repro (that the capability is missing), 2026-11-15, on `main` @ `b9b2d4fb`:**
`apps/mobile/package.json` has no drawer dependency (`@react-navigation/native`
7.5.1 + `native-stack` 7.21.0 only, no `react-native-gesture-handler` /
`reanimated` / `react-native-svg`); `RootStackParams` (`routes.ts:56-63`) has
no drawer; the Session header's left slot is `GlassButton icon="chevron.left"`
(`SessionScreen.tsx:341-350`); the dark `page` is `#000000` (`theme.ts:110`).

## Implementation

*— claude-opus-5-5, 2026-11-15 (revised the same day to the owner's answers: A1 + B1 + C1 + E2 + F1, F2 as an opt-in setting; Implementation APPROVED by the owner)*

The chosen look is **A1 + B1 + C1 + E2 + F1 (+ optional F2)** — mockup row
D of `.tentacle/tmp/mobile-chrome/mockups/index.html` is the visual reference
for every slice. Code starts **after `fix/mobile-chat-glitches` merges** (one
code task at a time, AGENTS §10; it edits `SessionScreen.tsx` and
`Composer.tsx` too).

### Load-bearing assumption

**The drawer needs no new data path and no new navigation library: it reuses
the per-computer session-list seam and the existing `Session` route.**
- The list: `createSessionListController({ load, now })`
  (`session-list-controller.ts:43-49`) is screen-independent; `SessionsRoute`
  builds it with `load` over `LINKS.get(computerId)` (`App.tsx:848-850`), and
  `viewModel(state, now)` (`session-list-controller.ts:135-150`) yields
  `SessionSections { active, archived }` (`session-list.ts:180-183`) with each
  row's `running`, `attached`, `archived`, `subtitle` (`session-list.ts:167`).
  The drawer builds the same controller for its selected computer.
- The switch: opening a session is `navigation.navigate("Session",
  { computerId, sessionId, title, archived })` (`App.tsx:1646-1655`); the
  `SessionRoute` resolves the link from `computerId` itself
  (`App.tsx:915-960`, `LINKS.get`), so a session of ANOTHER computer opens
  through the same route.
- The drawer itself is an overlay drawn with React Native core `Animated` +
  `Pressable` (no gesture/reanimated dependency, so no native rebuild): opened
  by the hamburger tap only (see failure mode F1 for the edge-swipe conflict).

Verify first (S5, before any drawer UI): a unit test drives
`createSessionListController` with a fake loader for two computers and
`drawerList` over its view-model; a navigation test asserts `drawerTarget`'s
route stack. If either needs a new client call, STOP and fix this plan.

### Preconditions

- **Tokens are the single source.** Every screen takes `Palette`
  (`theme.ts:10-66`, `paletteFor` `:148-150`); radii/sizes/spacing are
  `radius`/`size`/`space` (`theme.ts:197-247`). Changing the dark ramp and the
  radii there re-skins every screen — no per-screen colours exist to chase
  (the alias names were removed in mobile-ui-polish Slice 6, `theme.ts:6-7`).
- **Thin glyphs are available.** `Icon` draws SF Symbols via `expo-symbols`
  (`ui/Icon.tsx:1-8`); its prop allows only `regular|semibold|bold`
  (`ui/Icon.tsx:58`) but `SymbolWeight` includes `ultraLight|thin|light`
  (`node_modules/expo-symbols/build/SymbolModule.types.d.ts:81`). `IconName`
  is typed against `SFSymbol`, so `line.3.horizontal`,
  `chevron.up.chevron.down`, `gearshape` are checked by `tsc`.
- **The compact header already has the slots.** `ScreenHeader` `variant=
  "compact"` takes `left`/`right`/`subtitle` and the tap-to-rename title
  (`ui/ScreenHeader.tsx`, `onTitlePress`), so the header change is new slot
  contents, not a new header.
- **The context fraction exists.** `state.view.headerContext.percent`
  feeds the bar today (`SessionScreen.tsx:384-400`, orange ≥ 80): the ring
  reads the same number.
- **Rename works for any row.** `session/rename` "needs no prior open", an
  archived session is renamed in place (`protocol/src/session.ts:1067-1079`);
  `session-rename.ts:44` `renamePlan` is the existing pure decision.
- **New session without new protocol.** The client's session is created
  lazily on the first send (`client/src/remote-session.ts:7`, memoized
  create-or-attach `:208`); the phone today only builds attach-only handles
  (`App.tsx:235-238`, `session-controller.ts:65` "never create"). A phone-made
  session opens in that daemon's project (`docs/eval/mobile-app.md:126-130`,
  `cwd` not honoured). **Unverified:** that a handle built without `attach`
  creates on first send through the phone's `SessionController` path — S7
  proves it with the mock daemon before any button exists; if it needs
  daemon work, S7 splits out as its own task and the button is omitted.
- **Archived browsing never revives** (mobile-ui-polish Owner Q4,
  `routes.ts:24-28`): the drawer's archived rows navigate with `archived: true`
  exactly like the Sessions screen.

### Design

**1. Tokens (single source, `theme.ts`).**
- Dark ramp ← **B1** (Owner Q-B): `page`/`bg`
  `#1F1F1E`, `card`/`sheet`/`code` `#2A2A28`, `fill` `#33332F`,
  `codeOnSheet` `#33332F`, `label` `#F2F1EC`, `sec` `#A3A19B`, `sep`
  `#3A3936`, `sepChat` `#33322F`, `sepSheet` `#403F3B`, `glass`
  `rgba(42,42,40,0.86)`, `glassBorder` `rgba(255,255,255,0.07)`,
  `shadowOpacity` 0.35, `scrim` `rgba(0,0,0,0.45)`, `switchOff` `#45443F`.
  Accent and semantic colours unchanged; `tint`, `warnBg`, `addBg`/`delBg`
  re-checked on the new ground (contrast test below). New tokens: `drawer`
  (`#1A1A19` dark, `#F7F7F8` light) — one step BELOW the page so the panel
  reads as a layer without a shadow; `band` — the E2 section surface (dark
  `#2A2A28` = `card` on a `#1F1F1E` ground; light `#FFFFFF` on the `#F2F2F7`
  grouped ground) and `bandOnSheet` (dark: the sheet's ground becomes `page`
  `#1F1F1E` with `#2A2A28` bands; light: `#F2F2F7` ground, white bands), so a
  band always reads one step above what it sits on.
- Radii: `radius.sheet` 38 → **14**; `radius.card` 26 → **0** (E2: square
  bands, kept as a token). New `space.rowX` 20, `space.sectionTop` 22,
  `size.rowList` 50, `size.headerChat` 56 → **50**.
- `Icon` weight union gains `light` (and `thin`); header glyphs use `light`
  at 22 pt.

**2. Header (A1).** New primitive `ui/HeaderIcon.tsx`: a 44 pt
`Pressable` (touch target unchanged) with a bare `Icon` — no fill, no border,
no shadow; pressed = 0.5 opacity. Session header: left `line.3.horizontal`
(opens the drawer), right `ellipsis` (menu); the context bar becomes a 20 pt
`ui/ContextRing.tsx` left of "…" — accent arc, orange ≥ 80, tap → Session
info. Between the title and the ring sits the Activity pill (Design 5) in
"Header" mode. The
ring is drawn without `react-native-svg` (two clipped half-rings rotated by
the fraction — plain `View`s), so no native dependency; the arc's geometry
(`ringArcs(percent) → { rightDeg, leftDeg, tone }`) is a pure function in
`chat-header.ts`. The header gets a hairline bottom border (`sepChat`).
`GlassButton` stays for the FAB and over-camera buttons only. Every other
screen's header glass buttons (Computers "+", Settings back, Sessions back)
switch to `HeaderIcon` too — one weight across the app.

**3. Drawer (C1).**
- *Layout, top to bottom:* the **computer as the drawer's title** —
  `laptopcomputer` glyph + the computer name (17/600) + `chevron.down`, with
  a status line under it (dot + `Online`/`Offline`/`Connecting…` + the
  daemon's project, the `computer-status.ts` wording) and a magnifier on the
  right; then the session sections; then a footer: **Settings** (gear,
  bottom-left, → the Settings screen) and the primary **New session** pill
  (bottom-right).
- *What it lists:* the sessions of ONE computer — by default the computer of
  the open session. Tapping the title opens the **computer list** (a menu
  anchored under the title): every paired computer with its status dot and
  running count (`computer-rows.ts` `computerRows`, the Computers screen's
  data), the current one checked, then "Pair a computer" (→ `Pair`).
  Picking a computer changes only the drawer's list (local state, not
  persisted: the next open starts again from the open session's computer);
  the open session does not change until a row is tapped. With ONE paired
  computer the chevron is hidden and the title is not a button (nothing to
  switch to; "Pair a computer" stays on the Computers screen).
- *Sections:* **Running** (accent dot, "n attached"), **Recent** (idle, newest
  first, current highlighted with `fill`), then one **Archived · n** row that
  expands in place (collapsed by default; expanded automatically when the
  open session is itself archived, so the highlight is never hidden). Paging
  reuses `more()` at the list end. A search field is NOT in v1 (the Sessions
  screen keeps search); the magnifier in the mockup opens the Sessions screen
  with the search focused.
- *Row actions:* tap → open; long-press → action sheet **Rename** (the
  existing `RenameSheet` + `renamePlan`, `session/rename` by id — no open
  needed). Archive/Delete stay out (they need daemon-side session lifecycle
  from the phone — a separate task).
- *New session:* the primary pill bottom-right — creates a session on the
  drawer's selected computer (lazy create on first send, S7),
  navigates to it with title "(new)" and the composer focused.
- *Pure modules:* `drawer-list.ts` — `drawerList(sections, { currentId,
  archivedOpen }) → { running, recent, archived: { count, rows|null },
  currentIn: "running"|"recent"|"archived"|null }` (row VM: id, title, meta,
  tone, current) and `drawerTitle(computers, selectedId) → { name, status,
  switchable }` (switchable = more than one paired computer);
  `drawer-nav.ts` — `drawerTarget(from: SessionRoute, pick) → routes[]`:
  the stack `[Computers, Sessions(pick.computer), Session(pick)]` so
  back-swipe after a cross-computer switch lands on the RIGHT computer's
  list (`navigation.reset`), same-computer switch = `navigation.replace`
  (no stack growth); `drawerReducer` — open/close/selectComputer/
  toggleArchived/computerMenu open-close, so the component holds no
  branching.
- *Component:* `screens/SessionsDrawer.tsx` (render only) mounted by
  `SessionScreen` above the KAV: a 300 pt panel (`drawer`), the session
  pushed right by 300 pt and dimmed with `scrim`, 220 ms `Animated.timing`
  (respects Reduce Motion: no translate, fade only — `AccessibilityInfo`).
  Closes on scrim tap, row tap, or a left swipe on the panel
  (`PanResponder`, horizontal only). VoiceOver: the panel is
  `accessibilityViewIsModal`, the hamburger's label "Sessions", escape gesture
  closes.

**4. Banded lists (E2).** New primitive `ui/BandSection.tsx` replaces
`SectionHeader` + `GroupedCard` everywhere they are used
(`SessionInfoSheet`, `SettingsScreen`, `ComputersScreen`, `SessionsScreen`,
`PairScreen`):
- a **small uppercase section label** (12 pt, `sec`, +0.02 em tracking,
  `space.rowX` inset, `space.sectionTop` above, 6 pt below);
- then ONE **full-width band** per section: `band` surface (`bandOnSheet`
  inside a sheet), **square corners**, no side margin, a 0.5 pt hairline on
  its top and bottom edges (`sep`/`sepSheet`); rows inside it;
- an optional footnote under the band (13 pt `sec`).
`ui/Row.tsx` becomes full-width inside the band: 20 pt side padding,
`size.rowList` min height, a 0.5 pt hairline between rows inset 20 pt (none
after the last row — the band's own edge closes it), label `flexShrink: 0`
(never truncated, wraps at Dynamic Type sizes), value `flex: 1`
right-aligned with its own ellipsis — `ellipsizeMode` per value KIND,
decided in a pure helper `row-value.ts` (`valueEllipsis(kind)`: `path` →
head (`…/hop-live/proj` keeps the tail), `model` → middle, text → tail). The
status dot moves before the label (not under it). A row with a description
(Auto-accept) puts it under the label, the switch top-aligned. `Sheet.tsx`
uses `radius.sheet` 14, the `bandOnSheet` ground, and an 18 pt close glyph.
The drawer is NOT banded (its rows are navigation, mockup C1).

**5. Activity (F1; F2 opt-in, Design 6).** ONE sheet, "Activity", for everything
that runs beside the conversation, grouped by kind, running first.

*What exists daemon- and client-side today (no new protocol for sub-agents
or shell jobs):*

| Need | Exists | Where |
|---|---|---|
| Live list of background sub-agents (id `sa-N`, `agentType`, `description`, `state`, `toolUses`, `tokens`, `startedAt`, last 8 step labels `tail`, `model` only if it differs, `userRead`) | yes — full-state `subagents` display update, also in the open snapshot | `protocol/src/updates.ts` `SubagentsUpdateSchema`; `protocol/src/session.ts:546-580` `SubagentRowSchema`; snapshot `:734` |
| Foreground sub-agent progress (start / step / usage / end, `agentId` when it moves to background) | yes — `tool_progress` keyed by the `agent_task` call | `protocol/src/updates.ts:195-225` |
| Message a running child | yes — `session/subagent_message` → `{ok, reason?}`; echo `subagent_message{agentId, text, n}` | `protocol/src/session.ts:584-612`; `methods.ts:116` |
| Stop a child | yes — `session/agent_kill` → `{killed}` | `session.ts:615-624`; `methods.ts:118` |
| Child → agent notes | yes — `subagent_notify` | `updates.ts` `SubagentNotifySchema` |
| The report | yes — in the conversation, as the note message (`note{kind, id: "sa-N"}`) the agent receives | `session.ts:42-49` `MessageNoteSchema`; `docs/eval/subagent-live.md` M3 |
| Client API | yes — `RemoteSession.subagents`, `onSubagents`, `onSubagentMessage`, `messageSubagent`, `killSubagent`, `onJobs`, `jobOutput`, `killJob` | `client/src/remote-session.ts:586-735` |
| Background shell jobs (`bg-N`, command, `startedAt`, `status`; output on demand; kill) | yes — `jobs` update + `session/job_output` + `session/job_kill` | `updates.ts` `JobsUpdateSchema`; `session.ts:636-716`; `docs/feat/shell-jobs-panel.md` |
| "Waiting for your permission" as a child state | **no** — `state` is always `"running"` (`docs/feat/subagent-panel.md:97`); the ask arrives as the normal permission sheet, which names `sa-N` | — |
| Finished children with their report, kept in a list | **no** — a finished child LEAVES the list at once (owner P5); the phone keeps its own memory (below), no protocol | — |
| **Cron / scheduled jobs** | **no** — nothing in the protocol or daemon | needs its own task + new protocol (a list update + methods) |

So the phone's gap is purely app-side: the reducer drops these frames
(`transcript.ts:414-419`) and `SendableHandle` (`session-screen-controller.ts:66`,
over `SessionHandle`, `session-controller.ts:44`) does not expose the members
above. The handle type is widened with the eight `RemoteSession` members —
`App.tsx:235-238` already builds a `RemoteSession`, so no adapter.

*Entry point (F1, the default):* a pill in the session header — spinner
glyph + the running count (sub-agents + shell jobs), `tint`/`accent`,
between the title and the context ring — shown only while something runs or
a finished report is unread; tap → Activity. The `agent_task` card in the
transcript (replacing today's teal block) is the second, in-context entry:
tap → that child's detail (or, while it is still foreground, its live
steps). With the setting on "Floating" (Design 6) the pill is not drawn and
the floating button carries the count instead; the cards stay in both modes.

*Sheet:* medium detent, expandable. Sections, running first:
**Sub-agents · n running** (spinner, description, `sa-N · type · [model] ·
steps · elapsed`, the latest step in mono); **Shell jobs · n running** —
LIVE in v1 (the owner kept the recommendation): `bg-N`, the command in mono,
`status` · elapsed; tap → its output (`jobOutput`, last 200 lines, refresh on
pull) with **Stop** (`killJob`, one confirm); **Finished** (this attach
only: the last row of each child that left the list, joined with its report
note by `sa-N`; "Report ›"); **Scheduled** greyed "soon" (no protocol yet).
A live group with nothing in it is hidden. Elapsed is the client's clock
from `startedAt` (the protocol's accepted skew).

*Detail:* title = description; meta line state · `sa-N` · type · steps ·
elapsed · tokens. Running: **Latest steps** — the row's `tail` (5 shown,
owner Q17; "… n earlier" from `toolUses`), the newest with a spinner, the
user's own messages inline with "read" once `userRead ≥ n`; a bottom field
"Message sa-N…" (`messageSubagent`; a refusal's `reason` shown as a notice,
the draft kept) and **Stop** (confirm, then `killSubagent`; `{killed:false}`
→ "already finished"). Finished: **Report** (the note's markdown, rendered
by the transcript's renderer), Copy, Show in chat (scrolls to the note);
no message field.

*Pure modules (§7):* `activity.ts` — `activityView(subagents, jobs,
finished, now) → { count, groups[] }` (kind, rows, ghost) and the badge
rule; `activity-memory.ts` — a reducer that turns a `subagents` replace
into "left the list" events, keeps the last row + its outcome, and joins
the report note from transcript rows by `note.id` (bounded to the last 20);
`subagent-detail.ts` — `detailView(row|finished, messages, now)` (steps
window, read marks, which actions are allowed). Components: `ui/ActivityBadge.tsx`,
`screens/ActivitySheet.tsx`, `screens/SubagentDetail.tsx`,
`screens/JobDetail.tsx` — render only.

**6. Floating Activity button (F2, opt-in).** A phone-local setting,
**Settings → Activity button: "Header" (default) / "Floating"**.
- *Setting store:* `activity-settings-store.ts` — a versioned record
  `{v:1, mode: "header"|"floating", position?: {edge: "left"|"right",
  yFraction}}` behind the `SecureKV` port, the `voice-settings-store.ts`
  pattern (`voice-settings-store.ts:1-19`): unreadable / missing / unknown
  `v` → the DEFAULTS (`header`, no position); an unknown `v` is preserved
  (a write over it refused); a write failure rejects ("didn't save"). The
  Settings row is one more band row (E2) with a two-option picker.
- *Pure module `floating-button.ts` (all the physics and rules, no React):*
  - `snap(drop: {x, y}, bounds) → {edge, yFraction}` — nearest vertical
    edge by the button's centre; y clamped between the header's bottom +
    margin and the composer's top − margin (`bounds` from the measured
    layout, so the keyboard and the composer's growth are inputs, not
    guesses); the stored position is `yFraction` of that band, so a
    rotation, a Dynamic Type change or a different phone re-projects it
    (`place(stored, bounds) → {x, y}`);
  - `isTap(path)` — a press that moved < 6 pt and lasted < 300 ms is a tap
    (opens Activity); anything else is a drag (never both);
  - `visible({mode, count, unread, voiceOver})` — shown only in "floating"
    mode while something runs or a report is unread; hidden at zero
    (fades out, 150 ms);
  - `motion(reduceMotion) → {spring | fade}` — with Reduce Motion the snap
    is an immediate placement + a fade, no spring/overshoot;
  - `a11y(voiceOver) → {draggable: false, ...}` — with **VoiceOver** on the
    button is NOT draggable and NOT floating: it is placed at its stored
    edge, joins the reading order right after the header (`accessibilityLabel`
    "Activity, 2 running", `accessibilityHint` "Opens running sub-agents and
    jobs"), and activate = open; the header pill is ALSO drawn while
    VoiceOver runs, so the control is always where VoiceOver expects it.
- *Component `ui/FloatingActivity.tsx`* (render only): a 54 pt glass circle
  (`GlassButton` look, `glass`/`glassBorder`) with the spinner and a count
  badge, `PanResponder` (core RN, no gesture library) feeding raw points
  into `floating-button.ts`, `Animated.spring` for the snap; mounted by
  `SessionScreen` above the transcript, below sheets and the drawer (it
  hides while the drawer or any sheet is open). The position is written
  only on drop (not per frame).
- *Not done:* no free placement in the middle of the screen (always an
  edge), no dismiss-by-drag-to-bottom (the setting turns it off), no
  floating button on other screens.

### Files

Dependency order (all in `apps/mobile`; no protocol, daemon, client change —
S7 adds one if its verification fails, then splits out). The slice
that owns each file is in brackets.

1. `src/theme.ts` — dark ramp, `drawer`, `band`/`bandOnSheet`, radii,
   `space.rowX`/`sectionTop`, `size.rowList`, `headerChat` [S1].
2. `src/ui/Icon.tsx` — `light`/`thin` weights; new names (`line.3.horizontal`,
   `chevron.down`, `gearshape`) [S1].
3. `src/chat-header.ts` — `ringArcs(percent)` [S2]; `src/ui/HeaderIcon.tsx`,
   `src/ui/ContextRing.tsx` (new), `src/ui/ScreenHeader.tsx` (hairline,
   50 pt); every screen's header buttons → `HeaderIcon` [S2].
4. `src/row-value.ts` (new) — `valueEllipsis`; `src/ui/BandSection.tsx`
   (new), `src/ui/Row.tsx`, `src/ui/Sheet.tsx` [S3].
5. `src/screens/SessionInfoSheet.tsx`, `SettingsScreen.tsx`,
   `ComputersScreen.tsx`, `SessionsScreen.tsx`, `PairScreen.tsx` →
   `BandSection`; `src/ui/GroupedCard.tsx` + `src/ui/SectionHeader.tsx`
   deleted once unused [S4].
6. `src/drawer-list.ts`, `src/drawer-nav.ts` (new, pure) [S5].
7. `src/screens/SessionsDrawer.tsx` (new); `src/screens/SessionScreen.tsx`
   (hamburger, drawer mount; `session-back` → `session-drawer`); `App.tsx` —
   `SessionRoute` gets `onSwitch(target)` (→ `drawerTarget` →
   `reset`/`replace`), `computers`, a per-open drawer list controller (same
   `load` as `SessionsRoute`, `App.tsx:848-850`), `onOpenSettings`;
   `e2e/flows/26-drawer.yaml` (+ `.js` seed); `24-ui-shots.yaml`,
   `05-daemon-down.yaml` (both tap `session-back`) [S6].
8. The create-capable handle (`App.tsx:235-238` sibling) +
   `src/session-controller.ts` `openNew` if needed; `onNewSession` [S7].
9. `src/session-screen-controller.ts` (widen `SendableHandle`; subscribe
   `onSubagents`/`onSubagentMessage`/`onJobs`); `src/transcript.ts` (keep the
   `agent_task` card's progress instead of dropping it at `:414-419`);
   `src/activity.ts`, `src/activity-memory.ts` (new, pure);
   `src/ui/ActivityBadge.tsx`, `src/screens/ActivitySheet.tsx`,
   `src/screens/SubagentDetail.tsx` (report half) (new);
   `src/ui/ToolRow.tsx` (the agent card); `SessionScreen.tsx` (pill slot,
   sheet mount) [S8].
10. `src/subagent-detail.ts` (new, pure); `SubagentDetail.tsx` (steps,
    message, stop); `src/screens/JobDetail.tsx` (new);
    `e2e/flows/27-activity.yaml` (+ `.js` driving a background child and a
    shell job through the mock model) [S9].
11. `src/activity-settings-store.ts` + `src/activity-settings-expo.ts` (the
    `SecureKV` binding, `voice-settings-expo.ts` pattern),
    `src/floating-button.ts` (new, pure); `src/ui/FloatingActivity.tsx`
    (new); `SettingsScreen.tsx` (the "Activity button" row);
    `SessionScreen.tsx` (mount, mode switch); `App.tsx` (load the setting);
    `e2e/flows/28-floating-activity.yaml` [S10].
12. `changelog.d/mobile-chrome.changed.md` [S1–S6],
    `changelog.d/mobile-activity.added.md` [S8–S10]; this doc (every slice
    appends its Execution notes).

### Failure modes

- **F1 · Edge-swipe conflict.** iOS native-stack's left-edge swipe is "back";
  a drawer edge-swipe would fight it (and its loss is the one way back once
  the chevron is gone). Converges: the drawer opens on the hamburger TAP only;
  the edge swipe keeps meaning back (to the Sessions list of the open
  session's computer — guaranteed by `drawerTarget`'s stack, F4).
- **F2 · Drawer's computer offline / list fails.** The drawer shows the
  controller's `stale`/`error` state (the same wording as the Sessions screen,
  `session-list.ts` error mapping) with Retry; the title's status line says
  Offline with its dot; New session is disabled. The open session is untouched. Never an empty list that reads
  "no sessions".
- **F3 · Stale list vs live session.** The list is refreshed on every open
  (controller `refresh()`), and a late page from a previous open is dropped by
  the controller's generation counter (`session-list.ts:7-10`); the current
  row is highlighted by `currentId`, not by list order, so a session that
  moved still highlights.
- **F4 · Cross-computer switch then back.** Without a reset, back would land
  on computer A's list after opening B's session. `drawerTarget` returns the
  whole stack; tested.
- **F5 · Open session not in the loaded pages** (older than page 1, or
  archived). `currentIn: null` → no highlight, nothing invented; archived →
  section auto-expanded.
- **F6 · Switching mid-turn / with a draft.** Switching detaches only (the
  screen unmounts; the daemon keeps the turn — §7, detach never closes);
  drafts are per-session already (`drafts.ts`, outbox per computer) — the
  switch is a normal unmount. No `session/close` is ever sent.
- **F7 · Rename from the drawer fails** (offline, `UnknownSession`,
  `SessionDeleted`, older daemon `MethodNotFound`): the existing
  `RenameSheet` error path; the row keeps its old title until the list
  refresh shows the daemon's stored title.
- **F8 · New session on an offline computer / create fails.** The button is
  disabled while the selected computer's link is down; a failed create on the
  first send surfaces as the composer's existing send-failure state (outbox
  keeps the text), never a silently lost prompt.
- **F9 · Contrast regression from the new ground.** A pure test computes WCAG
  contrast for `label`, `sec`, `accent`, `green`, `orange`, `red`, `warnText`
  on `page`/`card`/`sheet`/`fill` in both palettes and pins the floors
  (≥ 4.5:1 text, ≥ 3:1 dots/glyphs), so a token tweak cannot quietly fail.
- **F10 · Dynamic Type.** Labels never truncate (they wrap); dense rows keep
  `DENSE_FONT_SCALE`; at the largest sizes a value drops below the label
  (Row's wrap rule, pure `rowLayout(fontScale)` if needed).
- **F11 · Reduce Motion / VoiceOver** — fade-only drawer; modal panel;
  hamburger labelled "Sessions"; ring labelled "Context 34%".
- **F13 · Activity on attach / reconnect.** The open snapshot carries
  `subagents` and `jobs` (`session.ts:734-736`), so the badge is right on the
  first frame; a reconnect re-reads them. The phone's Finished memory is
  per attach and is NOT persisted (the report itself stays in the
  conversation, so nothing is lost — only the shortcut).
- **F14 · Message / Stop races the child's end.** `messageSubagent` →
  `{ok:false, reason}` (not running, inbox full, finishing): shown, draft
  kept; `killSubagent` → `{killed:false}`: "already finished", the detail
  flips to Finished on the next `subagents` replace. Never a throw at the UI.
- **F15 · Older daemon** (`MethodNotFound` for the two methods, no
  `subagents` frames): the badge never shows, the card stays a plain tool
  row; message/stop report a typed refusal.
- **F16 · Untrusted text.** Descriptions, step labels and reports come from a
  daemon that may be a pod (§7 "a pod is not trusted"): rendered as plain
  text / the transcript's sanitised markdown, never as links that act, never
  interpreted. A message to a child is the user's own typed text only.
- **F17 · Stop is destructive.** One confirm ("Stop sa-2? Its work so far is
  lost to the agent") — the TUI's `x` then `y` (P4) on the phone.
- **F18 · Many children.** `subagents.maxParallel` bounds the running group;
  Finished is capped at 20 per attach; the sheet scrolls.
- **F19 · Shell job races.** `jobOutput` on a job that just exited →
  `found: false` or a final `status`/`exitCode`: the detail shows the last
  output it has plus "exited (code n)"; `killJob` → `{killed:false}` →
  "already exited". Output is plain mono text, sanitised (F16).
- **F20 · Floating button covers content.** It always rests on an edge,
  inside the band between header and composer (`snap` bounds), hides while
  the drawer or a sheet is open, and fades out at zero; the keyboard
  shrinks the band (bounds re-measured), so it never sits on the composer.
  If the band is too short (keyboard up on a small phone: < 2 × 54 pt) it
  hides until the keyboard closes.
- **F21 · Edge-swipe vs a left-edge button.** Resting on the LEFT edge it
  sits 10 pt inside the screen; the native back-swipe starts at the very
  edge (≤ ~20 pt), so a drag that begins ON the button is the button's
  (PanResponder grants on touch start inside it), anything else is the
  stack's. Pinned in flow 28 (back-swipe still works with the button on the
  left).
- **F22 · Setting store broken / newer.** Unreadable → defaults ("Header",
  no position): the user always has the pill; an unknown `v` is preserved,
  the Settings row says it cannot be changed by this build. A failed write
  → "didn't save", the mode in memory stays what the user picked for this
  run.
- **F23 · VoiceOver / Reduce Motion with "Floating".** VoiceOver: not
  draggable, fixed at its edge, in the reading order, and the header pill
  is drawn too (Design 6); Reduce Motion: no spring, placement + fade.
  Both read live (`AccessibilityInfo` change events), so toggling them
  mid-session converges without a restart.
- **F12 · Parallel branch.** `fix/mobile-chat-glitches` edits the same
  screen; this branch starts after it merges (§10), so no merge splice.

### Tests

Pure (bun test, `apps/mobile/test/`), red first:
- `theme.test.ts` — dark `page` is not `#000000` and matches the chosen
  value; the contrast floors of F9 for both palettes; `radius.card`/`sheet`.
- `chat-header.test.ts` — `ringArcs`: 0, 49, 50, 51, 100, >100 clamp, NaN →
  0; tone orange at 80.
- `theme.test.ts` (S1) also pins `band` one step above its ground in both
  palettes (`band` ≠ ground, contrast of `label` on `band` ≥ 4.5:1).
- `row-value.test.ts` — ellipsis per kind.
- `drawer-list.test.ts` — running/recent split, current highlighted in each
  section, current absent (F5), archived collapsed/expanded/auto-expanded,
  empty computer, stale + error passthrough; `drawerTitle`: one computer →
  not switchable, two → switchable, offline status wording.
- `drawer-nav.test.ts` — same computer → `replace`; other computer → stack
  `[Computers, Sessions(B), Session(B,x)]`; archived pick keeps
  `archived: true` (never reopen).
- `drawer-reducer` cases in the same file — open/close/select computer resets
  the archived toggle; reopening restarts on the open session's computer.
- S7 — with the mock daemon (`e2e/mock-model.ts` pattern / client
  fakes): a fresh phone handle creates on first send and appears in
  `session/list`; offline → send fails into the outbox (F8).
- `activity.test.ts` — count = running sub-agents + running shell jobs; badge hidden at zero with nothing unread; groups ordered running
  first; empty groups hidden; ghost groups only while flagged; elapsed from
  `startedAt` with an injected clock; unknown `state` shown as is.
- `activity-memory.test.ts` — a row that leaves the `subagents` list becomes
  Finished with its last row; the report joins by `note.id`, also when the
  note arrives BEFORE the list update (either order); cap 20; a reconnect's
  snapshot does not duplicate.
- `subagent-detail.test.ts` — steps window (5 of `tail`, "n earlier" from
  `toolUses`), read marks from `userRead` vs `n`, actions: running →
  message+stop, finished → copy+show; message refusal keeps the draft
  (F14); kill `{killed:false}` → "already finished".
- `activity.test.ts` also: shell jobs group live (count includes them),
  ordered after sub-agents; Scheduled always ghost; job exit (F19).
- `activity-settings-store.test.ts` — the three fail-safe rules (defaults
  on unreadable/missing/unknown `v`; unknown `v` preserved, write refused;
  write failure rejects), round-trip of `mode` + `position`, the
  `voice-settings-store.test.ts` shape.
- `floating-button.test.ts` — `snap`: centre left/right of the midline,
  exactly on it (→ right, pinned), y clamped to both bounds, a band
  shorter than 2 × size → hidden (F20); `place` re-projects a stored
  `yFraction` into new bounds (rotation, keyboard); `isTap`: 5 pt/200 ms
  tap, 7 pt drag, 400 ms long press not a tap; `visible` for every
  mode × count × unread; `motion(true)` has no spring; `a11y(true)` →
  not draggable + header pill also drawn (F23).
- Mutation check for F2: invert the midline rule, drop the clamp, ignore
  `voiceOver` → the tests above fail.
- Mutation check (§9): swap `replace`/`reset` in `drawerTarget`, drop the
  `currentId` match, break the `note.id` join → the tests above fail.

Maestro (`apps/mobile/e2e/flows/`, simulator, light AND dark via
`appearance.js`):
- `26-drawer.yaml` — open the drawer (`session-drawer`), current row
  highlighted, tap another session → its title in the header; open the
  computer menu, pick a second seeded computer, its list loads; back-swipe
  lands on that computer's Sessions list; long-press → Rename → the drawer row
  shows the new title; "New session" → empty session, send → it appears in
  the drawer (S7).
- `24-ui-shots.yaml` — new screenshots: session header (both themes), drawer,
  Session info, Settings, Computers — for the visual review against the
  chosen mockups.
- `05-daemon-down.yaml` — replace the `session-back` tap; drawer on a
  daemon-down computer shows the error + Retry (F2).
- `27-activity.yaml` — the mock model launches a background `agent_task`:
  the badge shows `1`; tap → Activity lists it with its latest step; open →
  steps advance; send "salta i test" → it shows "read"; Stop → confirm → the
  child leaves Running and appears under Finished; a second child ends on
  its own → its report opens from Finished; a shell job (`sleep 30 &`)
  appears under Shell jobs, its output opens, Stop ends it; badge hidden at
  zero.
- `28-floating-activity.yaml` — Settings → Activity button → Floating; a
  background child starts → the floating button appears (header pill
  absent), drag it to the left half → it snaps to the left edge; kill and
  relaunch the app → it comes back on the left; tap → Activity; back-swipe
  from the left edge still goes back (F21); keyboard up → it stays above
  the composer (F20); Settings → Header → the pill is back, no floating
  button. VoiceOver/Reduce Motion are covered by the pure tests (Maestro
  cannot toggle them reliably) — stated, not hidden.

### Slices

In order; each slice is green on its own (`bun test` of its files, then
`bun run check` before it is reported done) and appends to Execution.
"Strong" = the stronger model of the mix, "any" = a weaker model may
execute (AGENTS §10: blast gates who executes; the owner assigns the actual
model).

| # | Slice | Size · Blast · Suited | Contents (Files item) | Done when |
|---|---|---|---|---|
| S1 | **Tokens & palette** | S · cross-module (every screen reads it) · any; standard Review | `theme.ts` B1 ramp, `drawer`, `band`/`bandOnSheet`, radii, spacing; `Icon` weights (1, 2) | `theme.test.ts` contrast + band floors green; screenshots: soft dark everywhere |
| S2 | **Header (A1)** | S · contained · any; standard Review | `ringArcs`, `HeaderIcon`, `ContextRing`, `ScreenHeader` hairline; every header's glass buttons → `HeaderIcon` (3). The left button is still "back" until S6 | `chat-header.test.ts` green; flow 24 shots |
| S3 | **Band primitives (E2)** | S · contained · any; standard Review | `row-value.ts`, `BandSection`, `Row`, `Sheet` (4) | `row-value.test.ts`; a primitive-only screenshot |
| S4 | **Screens to bands** | M · cross-module · any; standard Review + visual check vs row D | SessionInfo, Settings, Computers, Sessions, Pair → `BandSection`; `GroupedCard`/`SectionHeader` deleted (5) | no import of the two deleted files; flows 24/25 green |
| S5 | **Drawer logic (C1)** | S · contained · strong; standard Review | `drawer-list.ts` (+ `drawerTitle`), `drawer-nav.ts`, `drawerReducer` (6) — proves the load-bearing assumption first | the four drawer test files + mutation check |
| S6 | **Drawer UI + navigation** | M · cross-module (navigation of the Session screen) · strong; fresh-context Review of F1–F7 | `SessionsDrawer.tsx`, hamburger, `App.tsx` `onSwitch`/list controller/`onOpenSettings`, rename from the drawer; flows 26 (minus New session), 24, 05 (7) | flow 26 green both themes; back-swipe lands on the right computer |
| S7 | **New session from the phone** | S · cross-module · strong; standard Review | verify lazy create with the mock daemon FIRST; then the create-capable handle + `onNewSession` (8). If it needs daemon work: STOP, split out, the pill is omitted | the slice-4 test (create on first send, offline → outbox) |
| S8 | **Activity F1, read-only** | M · cross-module (the phone consumes `subagents`/`jobs`; reducer change) · strong; standard Review | widen `SendableHandle`, keep the agent card's progress, `activity.ts`, `activity-memory.ts`, the header pill, the sheet (sub-agents + shell jobs live, Finished, Scheduled ghost), report view (9) | `activity*.test.ts` green; the pill shows on a live background child |
| S9 | **Activity actions** | S · cross-module · strong; standard Review | `subagent-detail.ts`, steps/message/stop, `JobDetail` output/stop; flow 27 (10) | `subagent-detail.test.ts`; flow 27 green |
| S10 | **Floating button (F2, opt-in)** | M · contained (behind a default-off setting; no protocol) · strong; standard Review | `activity-settings-store.ts` + expo binding, `floating-button.ts`, `FloatingActivity.tsx`, the Settings row, mode switch; flow 28 (11) | store + `floating-button` tests + mutation check; flow 28 green |

Then the task's **Review**: a fresh-context `/code-review` of the whole
branch (red-team F1–F23, "a pod is not trusted" for every rendered
sub-agent/job string, "detach never closes" on drawer switches) + a visual
comparison of flow 24's light/dark screenshots with mockup row D.

Cron / scheduled jobs are NOT a slice: they need daemon work and new
protocol first (their own task); this sheet only reserves the group.

### Notes / debt

- Archive / delete from the phone stay out (daemon-side lifecycle from the
  phone is its own task, `mobile-ui-polish.md:548-551`).
- Drawer search is deferred to the Sessions screen's existing search.
- The light palette is untouched; if the owner wants the light chrome softer
  too, it is one token edit.
- `GlassButton` survives only for the FAB, the camera chrome and the
  floating Activity button's look.
- The floating button is phone-local and per device (not synced across the
  owner's phones); the setting lives with the voice/lock settings.

### Owner questions

Each question maps to one mockup row of
`.tentacle/tmp/mobile-chrome/mockups/index.html`. **All answered** — see
"Owner answers" below; the recommendations are kept as the record of what
was proposed (C and E were overridden by the owner).

- **Q-A · Header.** A1 (thin hamburger + "…", no circles, context as a small
  ring next to "…") or A2 (no ring, the header hairline is the context bar)?
  *Recommendation:* **A1** — the ring keeps the context readable at a glance
  and is the "small status ring" the owner described; A2 is quieter but the
  1 px line is hard to read.
- **Q-B · Dark palette.** B1 `#1F1F1E` warm graphite, B2 `#262624` soft
  charcoal, or B3 `#1E1F21` cool slate? *Recommendation:* **B1** — clearly
  softer than black, still "night", the best contrast for secondary text;
  B2 reads washed-out in a dark room.
- **Q-C · Drawer.** Computer switcher at the bottom-left (C2) or as the
  drawer's title at the top (C1)? *Recommendation:* **C2** — matches the
  owner's reference proportions, gives the list the top of the screen, and
  switching computer is rarer than switching session; Settings and "Pair a
  computer" live in that same menu.
- **Q-D · The combination.** Approve A1 + B1 + C2 + E1 as the app's look
  (light unchanged except header/glyphs/flat lists)? *Recommendation:*
  **yes**, as shown in row D.
- **Q-E · Grouped screens.** E1 (bare full-width rows, hairlines, no
  containers) or E2 (one full-width band per section, square corners)?
  *Recommendation:* **E1** — the most minimal, the label never truncates,
  and the same grammar carries Settings, Computers and Sessions; E2 if the
  owner wants a little more structure.
- **Q-F · Activity entry point.** (a) F1 — a "⟳ n" pill in the header, shown
  only while something runs (plus the tappable agent cards in the
  transcript), or F2 — a draggable floating button that snaps to an edge
  (try it in the page)? And (b): shell jobs — greyed "soon" as mocked, or
  live in v1 (the daemon already exposes them)? *Recommendation:* **F1**
  and **jobs live in v1**. F1 follows iOS conventions, never covers the text
  you are reading, stays in VoiceOver order and needs no physics; its one
  weak point (top of the screen, far from the thumb) is covered by the cards
  in the transcript. F2 is fun but it covers code and buttons exactly where
  you read, fights the edge back-swipe, is an Android idiom and needs
  position memory and Reduce Motion handling. Jobs: they cost one more group
  over APIs that already exist (and fulfil TUI Q15, "one background list");
  cron stays greyed until its own task adds the protocol.

#### Owner answers (2026-11-15, on the mockups)

- Q-A header: **A1** (thin glyphs, no circles, context ring next to "…").
- Q-B dark palette: **B1** warm graphite `#1F1F1E`.
- Q-C drawer: **C1** — the computer is the drawer's TITLE at the top (tap → computers list); Settings + New session at the bottom (overrides the C2 recommendation).
- Q-E grouped screens: **E2** — one full-width band per section, square corners, small uppercase section labels (overrides the E1 recommendation).
- Q-F activity entry: **F1** header pill — **plus a setting to enable the floating draggable button (F2)** instead/in addition (off by default; Settings → Activity button: "Header" / "Floating"). Shell jobs: the recommendation (live in v1) stands unless the owner objects.
- Q-D the combination is therefore **A1 + B1 + C1 + E2 + F1 (+ optional F2)**.

**Revision to these answers** *— claude-opus-5-5, 2026-11-15:* Design 1–6,
Files, Failure modes (F20–F23 new), Tests, Maestro flows (28 new) and Slices
(S1–S10, each S/M with Size · Blast · Suited) now describe exactly this
combination; the C2/E1-specific details are gone. Interpretation recorded:
"Floating" REPLACES the header pill (the transcript cards stay in both
modes), except under VoiceOver, where the pill is also drawn (F23). Mockup
row D shows the chosen look in light and dark; the page passed a render
check in both modes (`render()` on a stub document: 6 rows, 26 phone
frames, no throw, no `undefined`/`NaN` in the markup). **Implementation
APPROVED by the owner (2026-11-15).**

## Execution

*(empty — Implementation APPROVED by the owner on 2026-11-15; S1 starts once `fix/mobile-chat-glitches` has merged)*

## Review

*(empty)*
