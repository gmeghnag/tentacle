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
  bands, kept as a token). The RenameSheet dialog is NOT a band — it gets its
  own `radius.dialog` 26 (unchanged pre-restyle value), the one non-band surface
  that drew `radius.card` (review round 1). New `space.rowX` 20,
  `space.sectionTop` 22, `size.rowList` 50, `size.headerChat` 56 → **50**.
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

1. `src/theme.ts` — dark ramp, `drawer`, `band`/`bandOnSheet`, radii
   (`radius.dialog` too), `space.rowX`/`sectionTop`, `size.rowList`, `headerChat`
   [S1]; `src/screens/RenameSheet.tsx` — its own `radius.dialog` [S1].
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

*— claude-opus-5-5, 2026-11-15 · slice S1 only*

**Scope: S1 (Tokens & palette) only.** S2–S10 untouched. No protocol, daemon,
client or wire change; `packages/protocol/schema/protocol.json` therefore did
not need regenerating (no schema changed — verified by `git status` naming only
`apps/mobile` files, the test file and the changelog fragment).

### Preconditions re-checked against the code (all held)

- **Tokens are the single source** — `Palette` at `theme.ts:14`, `paletteFor`
  `:169`; the only palette in the app (`App.tsx:1044`; `grep` for
  `lightPalette|darkPalette|paletteFor` outside `theme.ts` finds nothing else).
  Two hard-coded colour sites exist but neither is a *palette*: the
  over-camera chrome (`scanner.tsx:233-234`) and `GlassButton`'s `onDark` branch
  (`GlassButton.tsx:44,60,78`) — both intentional, both unchanged by S1. The
  claim "no per-screen colours exist to chase" holds.
- **Thin glyphs available** — `expo-symbols`' `SymbolWeight` carries
  `thin|light` (`node_modules/expo-symbols/build/SymbolModule.types.d.ts:81`),
  so only `Icon.tsx`'s own union blocked them. `line.3.horizontal`, `gearshape`,
  `chevron.down` all exist in `sf-symbols-typescript@2.2.0` (grepped: 8/19/15
  hits), so `IconName` still typechecks against `SFSymbol`.
- **`size.headerList` is load-bearing elsewhere** — `header-collapse.ts:16`
  derives `COLLAPSE_AT` from it, so S1 changes `headerChat` only (56 → 50) and
  leaves `headerList` at 52. Pinned by a test.

### Drift from the Implementation (2, both reconciled in code + here)

1. **`dark.red` had to move.** Design 1 says "accent and semantic colours
   unchanged … re-checked on the new ground". Measured: `#FF6961` on B1's `fill`
   (`#33332F`) is **4.4977:1** — under F9's 4.5 floor by 0.002, and `red` is drawn
   on `fill` at 3 real sites (`PermissionSheet.tsx:50` `{bg: palette.fill, fg:
   palette.red}`, `Row.tsx:63`, `PillButton.tsx:53`). So "unchanged" and F9 could
   not both hold. Took the minimal lift that clears the floor:
   `red: #FF6D65` (**4.6077** on `fill`, 5.223 on `card`, 5.992 on `bg`). This is
   recorded as a test so it cannot drift back. Everything else in the ramp is
   exactly B1 as written.
2. **`test/icon-weights.test.ts` was not in Tests.** `Icon.tsx` is `.tsx`, which
   Bun cannot import (React Native's sources are Flow), so the weight union is
   only pinnable from source — the existing `icon-glass-wiring.test.ts` pattern.
   Added as a new file rather than folded into that one (different concern).

One self-correction worth recording: my first draft of the "band is never its own
ground" test compared `band`/`bandOnSheet` against `sheet`. That is the wrong
property — a *banded* sheet's ground becomes `bg` (mockup `index.html:390`:
`sheet: … : p.page`, `band: … : p.card`), so the correct assertion is against
`bg` plus a luminance step. Fixed before green; the mutation check below proves
the corrected assertion still bites.

### As-built, in order

1. **Tests first (red).** `theme.test.ts` extended — `band`/`bandOnSheet`/
   `drawer` added to the 4.5:1 text-pair matrix, plus a new S1 section (B1 hexes,
   "never pure black", surface-step ordering, the `red` near-miss, band-vs-ground
   in both palettes, band text floors, `radius.card`/`sheet`, `space.rowX`/
   `sectionTop`, `size.rowList`, `headerChat` 50 + `headerList` 52). New
   `test/icon-weights.test.ts` (weight union, default weight, the three glyph
   names, no duplicate union members). **Red on the property, not on compile:**
   34 failing assertions, e.g. `Expected: 0 / Received: 26` (`radius.card`) and
   `Expected: 20 / Received: undefined` (`space.rowX`) — no import error, no
   type error, so the tests were measuring the behaviour.
2. **`src/theme.ts`.** B1 dark ramp; `drawer` `#1A1A19` (light `#F7F7F8`);
   `band`/`bandOnSheet` (`#2A2A28` dark, `#FFFFFF` light); `radius.card` 0,
   `radius.sheet` 14; `space.rowX` 20, `space.sectionTop` 22; `size.rowList` 50,
   `size.headerChat` 50. The `red` lift carries its own comment with the measured
   ratio.
3. **`src/ui/Icon.tsx`.** `weight` union gains `thin`/`light` (kept `regular`/
   `semibold`/`bold`; default unchanged at `semibold`, so no call site moves);
   `line.3.horizontal` and `gearshape` added (`chevron.down` was already there,
   so adding it would have duplicated a union member — the new test pins that).
4. **`changelog.d/mobile-chrome.changed.md`** — one bullet, parsed by
   `scripts/changelog.ts` `parseFragments` (`OK: ["changed/mobile-chrome"]`).
   `CHANGELOG.md` untouched, `TODO.md` untouched.

No S2–S10 file was opened for edit: `chat-header.ts`, `HeaderIcon.tsx`,
`ContextRing.tsx`, `ScreenHeader.tsx`, `BandSection.tsx`, `Row.tsx`, `drawer-*`
and the screens are all still as `main` left them. S1 changes **tokens and the
icon seam only** — the "soft dark everywhere"/banded-LOOK comes from tokens, but
no screen was rewired, so S2's `HeaderIcon` and S3's `BandSection` remain the
slices that spend these tokens.

### Mutation checks (§9 — each applied, run, reverted)

| # | Mutation | Result |
|---|---|---|
| 1 | `dark.red` back to `#FF6961` | 2 fail: `theme contrast (dark) > red on fill ≥ 4.5:1`, `S1 · B1's ground left the semantic colours readable` |
| 2 | `dark.band` = `#1F1F1E` (== its ground) | 2 fail: `dark: a band on the page…`, `a band is never its own ground…` |
| 3 | `radius.card` back to 26 | 1 fail: `radius.card is 0 (square bands) and radius.sheet is 14` |
| 4 | drop `"light"` from `Icon`'s weight union | 1 fail: `the weight union carries light and thin` |
| 5 | `size.headerChat` back to 56 | 1 fail: `the chat header is 50 pt, the list header untouched (A1)` |

After each revert the file was re-run green, so the reverts are real (no mutation
left in the tree — confirmed by `git diff` at the end naming only the intended
three files plus the two new ones).

### Gate

- `bunx tsc --noEmit` — **clean** (root, exit 0).
- `bunx tsc -p apps/mobile --noEmit` — **clean**.
- `bun run lint` — **`Checked 1656 files. No fixes applied.`** (0 errors, 0
  warnings; baseline per AGENTS §6 is clean, so no new issues).
- `bun test` — **11939 pass, 0 fail, 5 skip**. The 5 skips are exactly the
  documented opt-in ones (live-k8s ×2, live-docker ×2, the real-socket slow test);
  no non-opt-in skip, so nothing of mine is hidden behind a skip.

### Not done in this slice (and why)

- **The `done when`'s screenshots ("soft dark everywhere") are NOT captured.**
  Attempted `bun run e2e:mobile --ios 26 --only 24-ui-shots`: preflight passed
  (Java 17 present, `--ios 26` narrows the runtime requirement), the mock model,
  relay, `serve` and the seed all came up, and it failed at
  `build/install failed for iOS 26 (exit 1)` with
  `LACore.swift:23: error: Unable to resolve module dependency: 'PushCore'`.
  **That is pre-existing and unrelated to S1**: `git show HEAD:…/LACore.swift`
  already has `import PushCore` while
  `HEAD:…/expo-target.config.js` declares no Swift package, and my diff is
  TypeScript-only (`git diff --name-only` → `theme.ts`, `Icon.tsx`,
  `theme.test.ts`). Per AGENTS §0 I stopped after two attempts in that category
  rather than keep rebuilding. The visual pass therefore stays with S1's Review
  (or an e2e-capable machine); it is unverified here, and the honest state is
  "tokens proven by unit tests, pixels not yet seen".
- **`bun run check`'s exact sequence** was run as its three pieces above
  (`tsc --noEmit` → `lint` → `bun test`), all green; the chained script would
  only re-run them.
- One stray artifact from the failed run was removed
  (`apps/mobile/targets/live-activity/Info.plist`, generated by `expo prebuild`
  and NOT gitignored — only `ios/`, `android/`, `.expo/` are). Working tree holds
  only the intended changes.

### Fix round 1

*— claude-opus-5-5, 2026-11-15 · slice S1 · fixes Review round 1*

**Findings addressed:** 1 MEDIUM (plus the changelog nit it carried). No HIGH
was raised. Scope stayed S1 — tokens, the one non-band consumer, and the
wording; no S2–S10 file touched.

**1. MEDIUM — `radius.card` 0 squared a non-band surface. FIXED.**
Root cause: `radius.card` 26 → 0 is an E2 decision about the *band* surface,
but `RenameSheet.tsx:137` reused the same token for a centred, alert-style
dialog (maxWidth 340 over a scrim). The token change therefore sharpened a
surface E2 never meant to touch, and no later slice revisits it.

- `src/theme.ts:221-229` — new `radius.dialog: 26` with its own comment: it is
  not a band, it lost its corners only by sharing a token. The value is the
  pre-restyle `radius.card` value, so the dialog's *look* is exactly what it was
  before S1 (the reviewer's "keep ~14–26 pt" option, minus an invented number).
- `src/screens/RenameSheet.tsx:137` — `borderRadius: radius.card` →
  `radius.dialog`. Nothing else in the file moved.
- Design (l.177-181) and Files (l.389-391) updated, so the plan no longer says
  `radius.card` has one consumer.

**2. Nit — the changelog overclaimed. FIXED.** `changelog.d/mobile-chrome.changed.md`
said "no screen's layout or behaviour changes in this slice", which the
reviewer correctly called untrue (the chat header shortens, cards and sheets
take new corners, the dark ramp is visible at once). Reworded: tokens and the
icon seam only, no screen rewired, and the visible consequences named. Its
fragment still parses (`changed/mobile-chrome`).

**Tests (red before green, §9).** Two assertions added to `test/theme.test.ts`
(`S1 · E2 geometry`):
- `radius.dialog` is in 14–26 (the floor/ceiling the review named).
- no `.tsx` under `src/` reads `radius.card` unless it is a band primitive
  (`GroupedCard|BandSection`), plus a non-vacuity assertion that the scan sees
  at least one consumer today. This is the property that actually prevents a
  repeat: the bug was a *consumer*, not a value, and the original suite pinned
  only the value.

**Red, on the property, not on compile:** with the fix reverted (the code exactly
as review round 1 saw it) `bun test test/theme.test.ts` → **102 pass, 2 fail**,
both new assertions: `radius.dialog … Expected: >= 14 / Received: undefined` and
`radius.card is read only by the band primitives … Received: ["screens/RenameSheet.tsx",
"ui/GroupedCard.tsx"]`. Green after the fix: **104 pass, 0 fail**.

**Mutation checks (§9 — each applied, run, reverted; `git diff` after each revert
showed only the intended five files):**

| # | Mutation | Result |
|---|---|---|
| 1 | `radius.dialog` 26 → 0 (undo the fix's value) | 1 fail: `` `radius.dialog` keeps the alert-style dialog rounded `` |
| 2 | `RenameSheet` back to `borderRadius: radius.card` (undo the fix's consumer) | 1 fail: `` `radius.card` is read only by the band primitives `` |
| 3 | `GroupedCard` drops `radius.card` too (non-vacuity of the scan) | 1 fail: the same test — its `users.length > 0` assertion, so the scan cannot pass by seeing nothing |

Mutation 3 is the one that matters for a source-scanning test: without the
non-vacuity line a rename of the primitive would silently retire the guard.

**Precondition re-verified for the new token:** `radius.dialog` has exactly one
consumer (`RenameSheet.tsx:137`), confirmed by `rg -n 'radius\.(card|dialog)'
src` → `ui/GroupedCard.tsx:23` (card) + `screens/RenameSheet.tsx:137` (dialog).
The narrowed allowlist also survives S4, which replaces `GroupedCard` with
`BandSection` (both are named in the regex) — that is why it is not an exact
`toEqual(["ui/GroupedCard.tsx"])` as first written.

**Still unverified (unchanged from round 0, and it is the reviewer's own gap):**
the screenshots / visual pass. The e2e iOS build still fails on the pre-existing
`PushCore` resolution error, unrelated to this branch. So "the dialog's corners
look right on glass" is owed, not proven. To verify: run
`bun run e2e:mobile --ios 26 --only 24-ui-shots` once `PushCore` resolves and
open the rename flow's shot in both appearances.

**Gate (after the last edit, in the fixed tree):** `bunx tsc --noEmit` +
`bunx tsc -p apps/mobile --noEmit` + `bunx tsc -p apps/relay --noEmit` — **all
clean** (`TSC-ALL-OK`, exit 0). `bun run lint` — **`Checked 1656 files in 480ms.
No fixes applied.`** (0 errors, 0 warnings; baseline per AGENTS §6 is clean, so
no new issues). `bun test` — **11941 pass, 0 fail, 5 skip** (856 files); the 5
skips are exactly the documented opt-in ones (live-k8s ×2, live-docker ×2,
real-socket slow test). One earlier full run showed 2 fails in
`packages/daemon/test/serve-log-store.test.ts` (S2 crash/steer ordering); that
file passes 22/22 alone and the whole suite passed on the re-run, before this
round's code was final — it is a timing-sensitive pre-existing flake in an
untouched package, not a regression here, but it is recorded rather than
hidden.

## Review

*— claude-opus-5-5, 2026-11-15 · slice S1 only (same model as the executor, fresh context: shared blind spots possible)*

**Verdict: REQUEST-CHANGES** (one MEDIUM).

1. **MEDIUM — `radius.card` 0 squares a non-band surface.**
   `src/screens/RenameSheet.tsx:137` uses `radius.card` for the centred,
   alert-style rename dialog (maxWidth 340, floating over a scrim). S1 turns it
   into a sharp-cornered box. The plan's premise (Context l.37, Design 1 "E2:
   square bands") only names `GroupedCard.tsx` as a consumer, and no later slice
   touches RenameSheet's radius (S4 deletes only `GroupedCard`/`SectionHeader`),
   so the dialog stays square for good. Fix: give the dialog its own token (keep
   ~14–26 pt), or record the owner's OK, and pin it in `theme.test.ts`.
   The changelog's "no screen's layout … changes" is also not quite true: the
   chat header gets shorter and the inset cards/sheets get new corners (nit).

**Gate (re-run):** `bun test theme.test.ts icon-weights.test.ts` 106 pass / 0
fail; `bun run lint` clean (1656 files); `bun run typecheck` clean (root, mobile,
relay). I did not re-run the full suite.

**Premises:** `headerChat` is read only by `ScreenHeader` compact, used only by
`SessionScreen.tsx:377` — TRUE (chat-only). `headerList` untouched — TRUE.
`radius.sheet` only in `Sheet.tsx` — TRUE. `radius.card` only for cards — FALSE
(finding 1).

**Mutation (applied, run, reverted; `git status` clean afterwards):**
`dark.bandOnSheet` = `bg`, and `dark.drawer` lifted above `page` → 4 fail. The
executor's 5 mutations are consistent with how the tests are built.

**Attacks tried:** (a) other consumers of each changed token → finding 1;
(b) does `headerChat` move a list-screen collapse threshold → no;
(c) does a band/drawer surface break the 4.5:1 floors → no, the matrix covers
band/bandOnSheet/drawer in both palettes; (d) do the `IconName` additions
typecheck against `SFSymbol` → yes. §7 invariants: none touched (tokens only;
no protocol, persistence or terminal path).

**Unverified:** the screenshots / visual check (the e2e build is blocked by the
existing `PushCore` error). That is still owed before S1 counts as done.

**Executor behaviour:** honest. It recorded its drift (the `red` lift, with
measured ratios), followed red-before-green, and was candid about the missing
screenshots. It missed one token consumer.

### Round 2

*— claude-opus-5-5, 2026-11-15 · reviewing `git diff HEAD~1` (1ca15f98)*

**Verdict: APPROVE.** Finding 1 is fixed: `RenameSheet.tsx:137` now reads a new
`radius.dialog` (26, `theme.ts`). Two tests pin it: one keeps the value in
[14, 26], the other scans the `.tsx` sources and allows only band primitives to
read `radius.card`. The changelog nit is fixed too.

**Mutation (applied, run, reverted; `git status` clean afterwards):** switching
RenameSheet back to `radius.card` → 1 fail (the scan); setting `radius.dialog`
to 0 → 1 fail. **Gate:** the touched tests pass (108 pass / 0 fail across the 2
files), `bun run lint` is clean, `bun run typecheck` is clean. No regression in
the diff.
**Nit (not blocking):** nothing checks that RenameSheet uses `radius.dialog`
specifically (pointing it at, say, `radius.tile` would still pass). Screenshots
are still owed, as in round 1.

## Execution (slice S2 — header, A1)

*— claude-opus-5-5, 2026-11-16 · slice S2 only*

**Scope: S2 (Header, A1) only.** S3–S10 untouched: no `BandSection`, `Row`,
`Sheet`, `drawer-*`, `activity*`, `floating-button` or `SessionScreen` drawer work.
No protocol, daemon, client or wire change — no schema changed, so
`packages/protocol/schema/protocol.json` was **not** regenerated (confirmed:
`git status` names only `apps/mobile` sources, two test files, the doc and the
changelog fragment). `TODO.md` untouched. The left button is still "back", as
the slice's own `done when` says (it becomes the drawer in S6).

### Load-bearing check, re-run first (it held)

S2's slice-level assumption is Design 2's: **the ring can be drawn from plain
`View`s, so the header restyle needs no `react-native-svg` and no native
rebuild.** Evidence on the branch tip before any edit
(`.tentacle/tmp/mobile-chrome/s2-repro-before.log`, script pasted below):

```
== S2's new modules:
  MISSING src/ui/HeaderIcon.tsx
  MISSING src/ui/ContextRing.tsx
== ringArcs / ringLabel in src:
  (none if blank)
== the header still draws glass circles:
  GlassButton call sites in screens:       13
== the compact header has no hairline:
  (none)
== the context is a flat 2pt bar, not a ring:
739:  contextBar: { width: 64, height: 2, borderRadius: 1, overflow: "hidden" },
== react-native-svg (the dependency the ring must NOT need):
0
```

So the capability was genuinely absent, and `react-native-svg` is genuinely not a
dependency (`package.json`). The plan's cited preconditions were re-checked
against the code, not trusted:

- **Thin glyphs** — `Icon.tsx:64` now carries `"thin" | "light"` (S1 landed), and
  `SymbolWeight` carries both (`expo-symbols/build/SymbolModule.types.d.ts:81`).
- **The compact header has the slots** — `ScreenHeader`'s `compact` variant takes
  `left`/`right`/`subtitle`/`onTitlePress`, and it is used by exactly ONE screen
  (`grep 'variant="compact"'` → `SessionScreen.tsx:377`), so the hairline and the
  side-cluster change cannot touch a list screen.
- **The context fraction exists** — `session-view.ts:180`
  `headerContext: { percent, approx } | null`, fed by `session-info.ts:261`. The
  ring reads that same number; the screen's own `null` guard is preserved.
- **No gesture/svg dependency needed** — `react-native-svg` absent from
  `package.json`; the ring is `View`s, as Design 2 requires.

### Drift from the Implementation (3, each reconciled here)

1. **`ringHalfRotation` was not in the plan's Files list, and it is not
   optional.** Design 2 says the ring is "two clipped half-rings rotated by the
   fraction — plain `View`s", and asks only for `ringArcs(percent) →
   { rightDeg, leftDeg, tone }`. That is not enough to pin the geometry: the two
   *absolute* rotation bases (the window each half is empty at) are the actual
   look, and leaving them as constants inside `ContextRing.tsx` would put the one
   part that can be wrong — and that no screenshot can catch on this machine —
   in an unimportable `.tsx`. So the pure module gained
   `ringHalfRotation(arcs) → { right, left }` and `ringLabel(percent)`, both
   tested in `chat-header.test.ts`. This follows §7 (computation you'd want to
   test → pure module), it does not change the design's shape, and it spends the
   plan's own Design-2 sentence rather than inventing a new one.
2. **My first rotation bases were wrong, and the model caught it — not the
   code review.** The first write used `right = 135 + rightDeg`, `left = 315 +
   leftDeg`. Sampling all 36 000 half-degrees of the circle for the two windows
   (`.tentacle/tmp/mobile-chrome/s2-ring-geometry.ts`, output below) showed that
   mapping sweeping *backwards* — 0% painted the whole ring and 100% painted
   nothing. The correct bases are `right = 315`, `left = 135`, which are exact at
   every sample. This is exactly the class of error the plan warned about
   ("deriving rendering behaviour by armchair reasoning"), so it was decided by a
   measurement, and the corrected constants are pinned by a test.
   ```
   candidate A (135/315):  0% → 360deg painted, 100% → 0deg   WRONG
   candidate B (315/135):  0% → 0, 25% → 90, 50% → 180, 75% → 270, 100% → 360  OK
   ```
3. **`ScreenHeader`'s side column went `width` → `minWidth`.** A1 puts TWO
   targets ("…" and the ring) in the right cluster; at a fixed `width: 96` with
   `gap: 10` the second 44 pt button overflowed the column and would have been
   squeezed by `paddingHorizontal`. `minWidth: 96` keeps the title centred on an
   ordinary header and lets the ring cluster take its 98 pt. Behaviour identical
   on every screen that has one button or none.

One more, small: `HeaderIcon` gained `onLongPress` and `disabled` props while it
was being written (neither is used by S2's call sites). They are the two
affordances a header button has and S6's hamburger/drawer work needs them; a
prop with no caller is dead weight, but removing and re-adding them across
slices is worse. Recorded so the reviewer can rule on it.

### As-built, in order

1. **Tests first (red).** `chat-header.test.ts` gained the `ringArcs` block (0,
   49/50/51 split, 100, >100 clamp, NaN/negative, the 80 tone flip, `ringLabel`)
   and the `ringHalfRotation` block; new `test/header-wiring.test.ts` pins the
   wiring (bare `HeaderIcon`, default `light`/22, no `BlurView`/`shadow.glass`/
   `borderRadius` in it, no screen keeps a glass circle except over-camera, the
   five screens use `HeaderIcon`, the chat header draws the ring *guarded by a
   real reading*, the ring imports no svg, the compact hairline exists and the
   large variant has none).
   **Red on the property, not on compile:** 1 error
   (`SyntaxError: Export named 'ringArcs' not found` — the module genuinely had
   no such export) then, with the export added, **5 failing assertions** with
   readable diffs (`offenders: ["PairScreen.tsx","SessionScreen.tsx",…]`,
   `has: false` for `SessionScreen.tsx`, `not.toMatch(/contextBar:/)`), i.e. they
   were measuring the look, not the parse.
2. **`src/chat-header.ts`** — `RingTone`, `RingArcs`, `ringArcs` (`:66`),
   `ringLabel` (`:77`), `RingHalfRotation`, `ringHalfRotation` (`:107`).
3. **`src/ui/HeaderIcon.tsx`** (new) — a 44 pt bare `Pressable` + `Icon`,
   default `light` at 22, pressed 0.5, disabled 0.35, `label` for Pair's `Cancel`,
   `tone="accent"` for Computers' "+". No blur, no border, no shadow, no radius.
4. **`src/ui/ContextRing.tsx`** (new) — a 20 pt track (`sep`) + two clipped
   half-planes, each a full-size box whose `borderTop`/`borderLeft` arc is
   rotated by `ringHalfRotation`, the box offset half a ring inside its window so
   its centre stays the ring's. 44 pt tap target, `accessibilityLabel` from
   `ringLabel` (F11), tap → Session info.
5. **`src/ui/ScreenHeader.tsx`** — compact variant closes with one
   `hairlineWidth` line in `palette.sepChat` (large variant untouched); side
   column `minWidth: 96` + `alignItems: "center"`.
6. **The screens** — `SessionScreen` (`:384` back, `:398` ring, `:405` "…"),
   `SessionsScreen`, `SettingsScreen`, `ComputersScreen` (both buttons),
   `PairScreen` (`:175` `Cancel`) all swap their header `GlassButton`s for
   `HeaderIcon`. `GlassButton` therefore has exactly ONE live call site,
   `PairScreen.tsx:440` — the over-camera `Cancel`, which Design 2 keeps. (The
   plan also reserves `GlassButton` for the FAB, but no FAB exists yet, so there
   is no second site; the ring's `ContextRing` deliberately does not use it.)
   `SessionScreen`'s flat 2 pt `contextBar` and its style entry are gone; the ring
   carries `testID="session-header-context"`, so flow 25's assertion still holds
   (and it now taps Session info).
7. **`changelog.d/mobile-chrome.changed.md`** — the S1 bullet extended to cover
   the header (one bullet, one file, `parseFragments` OK). The plan's Files item
   12 says this one fragment spans S1–S6, so S2 extends it rather than adding a
   second `changed` fragment (a second file would be a real filename collision).
   `CHANGELOG.md` and `[Unreleased]` untouched.

### Mutation checks (§9 — each applied, run, reverted; script and full output in `.tentacle/tmp/mobile-chrome/s2-mutations.{sh,out}`)

| # | Mutation | Result |
|---|---|---|
| 1 | ring half-mark split 50 → 40 (the sweep overdraws) | 3 fail |
| 2 | orange threshold 80 → 90 | 1 fail |
| 3 | drop the `Number.isFinite` guard (broken transform) | 1 fail |
| 4 | swap the two rotation bases (the wrong mapping, drift 2) | 1 fail |
| 5 | put a `BlurView` back in `HeaderIcon` (a glass circle again) | 1 fail |
| 6 | default weight `light` → `semibold` (the old thick glyphs) | 1 fail |
| 7 | compact header hairline `hairlineWidth` → 0 | 1 fail |
| 8 | the ring drawn unconditionally (no reading guard) | 1 fail |
| 9 | `ContextRing` ignores `ringHalfRotation` (magic constants) | 1 fail |

**Mutation 8 found a real vacuity, and it was fixed.** The first version of that
assertion was `expect(SESSION_SCREEN).toMatch(/<ContextRing\b/)`, which is blind
to whether the ring is *guarded* — mutation 8 (`headerContext === null ? null :`
→ `true ? null :`) passed it, so the test proved nothing. Rewritten to locate the
guard and assert the `<ContextRing` + `percent={state.view.headerContext.percent}`
inside it (plus "no old bar"), after which mutation 8 fails as it should. Every
row above is from the run *after* that fix; the baseline before each mutation and
the green re-run after each revert were both `20 pass / 0 fail`, and `git diff`
after the script names only the intended files.

### Gate

- `bunx tsc --noEmit` (root) — **clean**.
- `bunx tsc -p apps/mobile --noEmit` — **clean**. (First run reported
  `packages/agent/src/capabilities.ts(20,8): Cannot find module '@tentacle/config'`
  — a stale `node_modules` in this worktree, not my code: the same error appears
  on an untouched worktree, and `bun install --frozen-lockfile` in this one
  cleared it. Nothing in `packages/` is modified.)
- `bunx tsc -p apps/relay --noEmit` — **clean**.
- `bun run lint` — **`Checked 1661 files. No fixes applied.`** (0 errors, 0
  warnings; AGENTS §6 baseline is clean). The first run flagged 8
  format/`organizeImports` errors in my own files only; `biome check --write` on
  exactly those 11 files fixed them.
- `bun test` (full suite) — **11978 pass, 5 skip, 0 fail** across 858 files. The 5
  skips are the documented opt-in ones (live-k8s ×2, live-docker ×2, the
  real-socket slow test); no non-opt-in skip.
- `packages/protocol/schema/protocol.json` — **not regenerated**: no schema
  changed (no `packages/protocol` file in the diff).

### Not done in this slice (and why)

- **The `done when`'s "flow 24 shots" are NOT captured.** The e2e build is still
  blocked by the pre-existing `PushCore` error S1 recorded
  (`apps/mobile/targets/live-activity/LACore/LACore.swift:23` imports `PushCore`;
  `expo-target.config.js` declares no Swift package, and `git diff` shows I did
  not touch `targets/`). Per AGENTS §0 this is the second slice hitting the same
  wall, so it is not retried here: **the ring's pixels are unverified on a device
  / simulator**. What IS verified: the geometry (numerically, and by test), the
  sizes, the colours read from tokens, and that no screen still draws a glass
  header circle. The visual pass is owed to Review or an e2e-capable machine, and
  the honest state is "geometry and wiring proven, pixels not yet seen".
- **The ring's rotation is a clockwise sweep from 12 o'clock** by construction of
  the two windows; whether the owner prefers the remaining fraction in `sep` to
  read as "used" vs "free" is a mockup detail I did not invent an answer to — the
  mockup (`index.html:221` `ring(p, pct)`) draws the *used* fraction in accent
  over a `sep` track, and that is what this paints.
- **`Icon`'s `thin` weight is unused by S2.** A1's header glyphs are `light`; the
  union carries `thin` from S1 for the drawer's future glyphs. No call site uses
  it, so nothing pins it beyond S1's union test — stated rather than implied.

### Fix round 1 (slice S2)

*— claude-opus-5-5, 2026-11-16 · slice S2 · fixes Review round 1 (S2)*

**Findings addressed:** both MEDIUM, no HIGH raised. Tests only — no product code
changed, which is the correct shape for both: neither finding was a bug in the
shipped code, each was a coupling no assertion held. Scope stayed S2; `git diff`
names one file (`apps/mobile/test/header-wiring.test.ts`, +31 lines).

**Reproduced first (before any edit).** Both mutations applied to the untouched
tree, the slice's two test files run:
`.tentacle/tmp/mobile-chrome/f1-repro.sh` → `20 pass / 0 fail` for **both**. So
both gaps were real, and neither "test" was red on the property it claimed.
Script and output: `.tentacle/tmp/mobile-chrome/f1-repro.{sh,out}`.

**1. MEDIUM — the ring's tap wiring was not pinned. FIXED.**
Root cause: `header-wiring.test.ts` asserted only that `ContextRing.tsx`
*declares* `onPress?: () => void` (a property of the component), never that the
chat header *passes* one — and the component's own `onPress === undefined` branch
silently renders a `progressbar` instead of a `button`, so dropping the prop at
`SessionScreen.tsx:401` costs no type error and no test.
- `test/header-wiring.test.ts:121-128` — new test: take the `<ContextRing …/>`
  element the header writes and assert `onPress={` **and** `setInfoOpen(true)`
  inside it. Asserting the *value*, not just the prop's presence, so wiring the
  tap to the wrong setter also fails.
- `test/header-wiring.test.ts:33-39` — `ringCallSite()` helper: slices from
  `<ContextRing` to the following `/>` and asserts both boundaries exist, so the
  test cannot pass by slicing an empty string (the classic source-scan vacuity).

**2. MEDIUM — the arc's border sides were not pinned. FIXED.**
Root cause: `ringHalfRotation`'s bases (315/135) are only correct for a
`borderTop`+`borderLeft` arc (centred at 10:30). That coupling has two halves; the
pure half is tested in `chat-header.test.ts`, the component half had no assertion,
so `borderLeftColor → borderRightColor` moved the arc's centre to 1:30 with every
test green — a phantom 90° at 0% and a wrong sweep everywhere.
- `test/header-wiring.test.ts:130-142` — assert the arc reads `borderTopColor:
  tone` **and** `borderLeftColor: tone`, and that neither `borderRightColor` nor
  `borderBottomColor` appears in the file. The negative halves are what catch a
  future side swap, not just a missing side. Comment names the coupling to the
  bases so the next editor sees why the sides are not a free choice.

**Drift from the Implementation: none.** Both fixes are test-only, so the Design
sections still describe the code as built.

**Red before green (§9), on the assertion, not on an import/compile error** —
`.tentacle/tmp/mobile-chrome/fix1-red.{sh,out}`, new tests against the mutated
buggy code, each applied → run → reverted (`RESTORED-OK`):

| Mutation (buggy code) | Result |
|---|---|
| `<ContextRing>` loses `onPress={(…)}` | **21 pass / 1 fail** — `Expected substring or pattern: /onPress=\{/`, `Received: "<ContextRing\n palette={palette}\n …"` |
| `borderLeftColor` → `borderRightColor` | **21 pass / 1 fail** — `Expected substring or pattern: /borderLeftColor: tone/` |
| `borderTopColor` → `borderBottomColor` | **21 pass / 1 fail** — `Expected substring or pattern: /borderTopColor: tone/` |

Green after: **22 pass / 0 fail** (65 `expect()` calls).

**Mutation checks on the fixed tree** — `.tentacle/tmp/mobile-chrome/fix1-mutations.{sh,out}`,
baseline `22 pass / 0 fail` before, every revert verified by `diff` (`REVERT-OK`):

| # | Mutation | Result |
|---|---|---|
| A | `onPress={() => setInfoOpen(true)}` → `setInfoOpen(false)` (right prop, wrong target) | 1 fail — the passes-the-tap test |
| B | drop `onPress=` from the call site (the finding's own) | 1 fail — the same test |
| C | `borderLeftColor` → `borderRightColor` (the finding's own) | 1 fail — the arc test |
| D | the arc redrawn as one full circle (`borderColor: tone`) | 1 fail — the arc test |
| E | the whole `<ContextRing …/>` deleted (non-vacuity of the call-site slice) | 2 fails — the "draws `ContextRing`" guard test **and** the new tap test (`ringCallSite`'s own `indexOf` assertions), so it cannot pass on `""` |

A and D are the ones that matter beyond the two findings: A proves the test pins
the *destination* of the tap, not the presence of a prop; D proves the arc test
pins the half-arc shape, not merely "a colour is set somewhere".

**Fix round 2's nit (round-2 review of *S1*) carries over, still open and still
non-blocking for S1:** nothing asserts that `RenameSheet` uses `radius.dialog`
specifically. Named here so it is not mistaken for new debt from this round —
this round added no `theme` assertions.

**Still unverified (unchanged, third slice to hit it):** the pixels. The e2e iOS
build is still blocked by the pre-existing `PushCore` resolution error
(`targets/live-activity/LACore/LACore.swift:23`), `targets/` untouched by this
branch, so flow 24's shots were not captured and the ring has never been seen on
glass. Per AGENTS §0 this is not retried a third time. To verify: run
`bun run e2e:mobile --ios 26 --only 24-ui-shots` on an e2e-capable machine and
open the chat header in both appearances — 0%, ~34%, ~85% (orange) are the cases
the geometry test names.

**Gate (after the last edit, in this tree):**
`bunx tsc --noEmit` — clean (`TSC-ROOT-OK`); `bunx tsc -p apps/mobile --noEmit` —
clean; `bunx tsc -p apps/relay --noEmit` — clean. `bun run lint` — `Checked 1661
files in 456ms. No fixes applied.` (0 errors, 0 warnings; AGENTS §6 baseline is
clean). `bun test` (full suite) — **11980 pass, 5 skip, 0 fail** across 858 files
(13 snapshots, 85024 `expect()` calls, 420 s); the 5 skips are the documented
opt-in ones (live-k8s ×2, live-docker ×2, the real-socket slow test), no
non-opt-in skip and no flake this run. The count is +2 against the previous
slice's 11978, which is exactly the two new tests.

## Review

*— claude-opus-5-5, 2026-11-16 · slice S2 only, fresh context. The Execution
section above is also signed claude-opus-5-5, so the shared-blind-spot caveat
(AGENTS §10) applies.*

**Verdict: REQUEST-CHANGES** (two MEDIUM test-coverage gaps; no HIGH, no code bug found).

**Gate (scoped, as asked):** `bun test chat-header.test.ts header-wiring.test.ts`
gave 20 pass / 0 fail; `bun run lint` is clean; `bun run typecheck` is green.
The full `bun run check` was not run. Maestro flow 24 (screenshots) was not run
because there is no simulator, so the pixels are still unseen.

**Findings**
1. MEDIUM: the "tap the ring → Session info" wiring is not pinned
   (`SessionScreen.tsx:401`, `header-wiring.test.ts:752`). Mutation: deleting
   `onPress={() => setInfoOpen(true)}` from the `<ContextRing>` call site leaves
   all 20 tests green. The test only checks that `ContextRing` *declares*
   `onPress?`. Failure scenario: a refactor drops the prop, the ring shows up as a
   non-interactive `progressbar` (the `onPress === undefined` branch), and Design
   2 / F11's tap target silently disappears. Fix: assert `onPress=` inside the
   guarded `<ContextRing` slice that the test already takes.
2. MEDIUM: the arc's border sides are not pinned (`ContextRing.tsx:387-388`).
   `ringHalfRotation`'s bases (315/135) are correct ONLY for a
   `borderTop`+`borderLeft` arc (centred at 10:30). Mutation: `borderLeftColor` →
   `borderRightColor` leaves all tests green and moves the arc's centre to 1:30.
   Neither half then starts empty at 0%: the ring shows a phantom 90° at 0% and a
   wrong sweep everywhere. The executor's "verified numerically" claim covers the
   pure function, not this coupling. Fix: assert both `borderTopColor: tone` and
   `borderLeftColor: tone` (or move the side choice into the pure module next to
   the bases).

**Mutations:** swapping the right base 315→135 fails as expected. So does a
hairline coloured `sep` instead of `sepChat`. #1 and #2 above survive. All edits
were reverted, and `git status --porcelain` is empty.

**Attacks tried (nothing found):**
- Geometry, re-derived by hand: 0/25/50/75/100% gives 0/90/180/270/360°,
  clockwise from 12.
- The relative `left:-10` offset inside the 10 pt window keeps the rotation
  centre on the ring's centre.
- Typecheck covers the `GlassButton`→`HeaderIcon` prop compatibility.
- The Pair "Cancel" header is not over the camera. The scanner's close button
  keeps `GlassButton onDark` (`PairScreen.tsx:440`).
- Flow 25 still finds `session-header-context` by id.
- The ring and "…" hit slops (10 + 4 against a 10 pt gap) do not overlap either
  box.
- No `react-native-svg` dependency.
- No §7 invariant is touched (render-only, geometry in the pure module).

**Executor behaviour:** in scope (S3–S10 untouched), honest about the unseen
pixels, and the geometry is pinned in the pure module as §7 asks. But two
mutations on the slice's own load-bearing couplings were not tried.

### Round 2

*— claude-opus-5-5, 2026-11-16 · checks `git diff HEAD~1` (00e3a67d), which is
test + doc only and changes no source.*

**Verdict: APPROVE.** Both round-1 findings are closed, and I found no new HIGH
or MEDIUM issue.

- **Finding 1 (ring tap):** closed. I re-ran it with a mutation: dropping
  `onPress` from the `<ContextRing>` call site now FAILS the new test, "PASSES
  the tap through". I also pointed the tap at `setMenuOpen(true)`, the wrong
  target, and that FAILS too. Two possible holes do not apply. `ringCallSite`
  slices from `<ContextRing` to the first `/>`. That marker cannot be cut early
  by `=>`. The slice can never be empty, because it is guarded by `expect`s on
  both indices.
- **Finding 2 (arc border sides):** closed. Re-running `borderLeftColor` →
  `borderRightColor` now FAILS the test "the arc stays the
  `borderTop`+`borderLeft` half".
- **Regressions:** the diff touches no source code. The two touched test files
  give 22 pass / 0 fail. `bun run lint` is clean and `bun run typecheck` is green.
  I reverted every mutation, and `git status --porcelain` is empty.
- **Still open:** the S2 pixels are unseen (flow 24 needs a simulator), which is
  the executor's own stated debt. These are source-scan tests, which is the
  repo's accepted pattern for `.tsx` that Bun cannot import.

## Execution (slice S5 — drawer logic, C1)

*— claude-opus-5-5, 2026-11-16 · slice S5 only*

**Scope:** S5 only, pure modules + tests. Nothing else was touched: no UI, no
`App.tsx`, no protocol/daemon/client change, so `protocol.json` was not
regenerated (no schema changed).

**Provenance (stated honestly):** the six S5 files were already in the
worktree as **untracked** files at the start of this run (mtime 2026-11-16 00:50,
no Execution entry). They came from an earlier, unrecorded attempt. I did not
author them. I verified them against the plan and the code, kept them, added
one guard (below), and did the red/mutation evidence myself.

### Load-bearing check, re-run first (it held)

- `createSessionListController({ load, now })` and `viewModel(state, now)`
  (`session-list-controller.ts:49`, `:135-155`) are screen-independent.
  `App.tsx:852-854` builds one over `LINKS.get(computerId)` (the plan cited
  `:848-850`, which drifted by 4 lines). `SessionRoute` resolves its own link
  from `computerId` (`App.tsx:944`). The Sessions screen opens a session with
  `navigation.navigate("Session", …)` (`App.tsx:1651`).
- `drawer-seam.test.ts` drives two controllers over two fake `session/list`
  loaders (computers a/b) into `drawerList`. The only injected call is the
  existing loader, so the drawer needs **no new client call**.
  `drawer-nav.test.ts` asserts `drawerTarget`'s stack. Both are green, so the
  plan stands.

### Drift from the Implementation (each kept, reasons)

1. **`drawerTitle(records, rows, selectedId)`**, not `(computers, selectedId)`.
   The paired records are synchronous, but the probed `ComputerRow`s
   (`computerRows`) arrive later. So the title names the computer from the
   record and says "Connecting…" until its row exists. A computer that is no
   longer paired returns `null`, so no title is invented. It also returns
   `tone`, `project` and `canCreate` (online only; F2/F8).
2. **`archivedOpen: boolean | null`** (null = automatic). The auto-expand for
   an archived current session (F5) can then be overridden by an explicit
   collapse. `toggle-archived` flips what is SHOWN.
3. **`drawerTarget` returns `DrawerNav`** = `stay | replace{route} |
   reset{routes}`. `stay` is the open session itself on the same computer (just
   close: no remount, no detach). The same id on ANOTHER computer is a
   different session, so it resets.
4. **Added `drawerCurrentId(state, from)`** (`drawer-nav.ts`, mine). It
   highlights only while the drawer lists the open session's OWN computer.
   Without it, S6 would need a branch in the component (§7), and an equal
   session id on another daemon would be highlighted wrongly.
5. **The reducer lives in `drawer-nav.ts`**, with its own test file
   (`drawer-reducer.test.ts`). The Slices table says "four drawer test files":
   seam, list, nav, reducer.

### As-built

- `apps/mobile/src/drawer-list.ts`: `drawerList` (Running/Recent split in
  the daemon's order; current matched by id; Archived · n collapsed, auto or
  toggled; `empty` only for a fresh successful empty read, never when stale or
  failed (F2); stale/error/`canLoadMore` passed through) and `drawerTitle`.
- `apps/mobile/src/drawer-nav.ts`: `drawerTarget`, `drawerCurrentId`,
  `initialDrawer`, `drawerReducer` (open/close/select-computer/
  toggle-archived/menu). Every open restarts on the open session's computer;
  selecting a computer resets the archived toggle and shuts the menu.
- Tests: `apps/mobile/test/drawer-{seam,list,nav,reducer}.test.ts`, 27 tests.
- **Red before green:** `drawerCurrentId` was written as a naive stub
  (`return from.sessionId`) first. The test "another computer listed: nothing
  highlighted" went RED on its assertion (`Received: "s1"`), then green with
  the real rule. The pre-existing code had no pre-implementation red I could
  show, so its non-vacuity rests on the mutations below.
- `biome check --write` formatted `drawer-nav.test.ts` (the earlier attempt
  left it unformatted; that was the only lint error).

### Mutation checks (§9: each applied with Edit, the 4 drawer files run, reverted; final `cmp` against scratch backups = identical)

| # | Mutation | Caught by (fail) |
|---|---|---|
| M1 | swap `replace`/`reset` (`if (!sameComputer)`) — **plan target** | 4: same computer → replace; other → reset (F4); archived pick; same id other computer |
| M2 | drop the `currentId` match (`current: false`) — **plan target** | 3: seam two-computers; highlight per section; archived auto-expand |
| M5 | no archived auto-expand (`?? false`) | 2: highlight per section; archived auto-expand |
| M6 | stale/error reads as empty (`empty: source.empty`) | 1: "a failed or stale read is not (F2)" |
| M8 | one computer switchable (`> 0`) | 1: one paired computer not switchable |
| M10 | archived pick dropped (`archived: false`) | 1: archived pick keeps `archived: true` |
| M3 | select-computer keeps the archived toggle | 1: selecting a computer resets the toggle |
| M9 | create while offline (`canCreate: true`) | 2: offline; needs pairing again |
| M4 | reopen keeps the picked computer | 1: reopening restarts on the open session's computer |
| M11 | `stay` ignores the computer | 1: same id on ANOTHER computer |
| M7 | highlight ignores the listed computer | 1: drawerCurrentId other computer |

The plan's third mutation target, "break the `note.id` join", belongs to S8
(`activity-memory`). It is not in S5.

### Gate

- `bunx tsc --noEmit`: clean. `bun run typecheck` (root + `apps/mobile` +
  `apps/relay`): clean.
- `bun run lint`: 1668 files, 0 errors/warnings.
- `bun test`: **12035 pass · 5 skip · 0 fail** (863 files). The skips are all in
  pre-existing opt-in live files (k8s/docker/exec-confinement/ws-server/
  session-hop docker). None are in `apps/mobile`.

### Not done in this slice (and why)

- No UI, no wiring. `SessionsDrawer.tsx`, the hamburger, `App.tsx`
  `onSwitch` and the flows are S6. S6 maps `DrawerNav` to
  `navigation.replace`/`reset` and passes `drawerCurrentId(...)` to
  `drawerList`.
- **Changelog:** S5 has no user-visible effect (the modules are not wired). The
  task's single fragment `changelog.d/mobile-chrome.changed.md` (S1–S6) is
  unchanged. S6 adds the drawer to it.
- Nothing committed (the orchestrator commits).

## Review

*— claude-opus-5-5, 2026-11-16 · slice S5 only, fresh context (same model family as the S5 Execution signature: shared blind spots possible)*

**Verdict: APPROVE (PASS)** — no HIGH/MEDIUM findings. Scope: `git diff main...HEAD` (6 S5 files + this doc).

**Gate (re-run):** the 4 drawer test files 27 pass · 0 fail (77 expects); `bun run lint` 1668 files clean; `bun run typecheck` (root + mobile + relay) clean. Full `bun test` not re-run (pure leaf modules, nothing imports them yet).

**Premise table:** `App.tsx:852-854` builds a controller over `LINKS.get(computerId)` TRUE; `:944` `SessionRoute` resolves its own link TRUE; `:1651` `navigate("Session", …)` TRUE; `session-list-controller.ts:49` / `:135` TRUE; `viewModel.empty` = `entries.length===0 && status==="loaded"` TRUE; `routes.ts` stack `Computers → Sessions{computerId,name} → Session{…,archived}` TRUE. The load-bearing assumption (no new client call) holds: the seam test injects only the existing loader.

**Mutations (mine, with Edit, reverted; `git status` clean after):** `??`→`||` on the archived auto-expand → caught (explicit collapse test); drop `!source.stale` from `empty` → caught (F2 stale-empty); `toggle-archived` ignores `shown` → caught; `close` keeps `menuOpen` → caught; drop `archivedRows.length > 0` guard → **survives** (LOW: `archivedOpen:true` with 0 archived rows yields `[]` instead of `null`; harmless for render, untested).

**Attacks tried:** (1) same id on another computer → `reset`, not `stay`, and no highlight via `drawerCurrentId` — holds. (2) F2: stale/error never `empty` — holds. (3) F4 stack shape incl. `archived:true` on both paths (Owner Q4) — holds. (4) `canCreate` from `computerStatus`: a probe that fails while the link diagnoser still says `ok` (dial fine, `session/list` errors) yields `state:"ok"` (`computer-rows.ts:79-89`, `App.tsx:528`) → title "Online", `canCreate:true` — pre-existing `computerRows` behaviour, LOW; S6/S7 should not rely on `canCreate` alone (the create path's own failure state, F8, is the real net). (5) §7 "logic in pure modules": all branching is in `drawer-list.ts`/`drawer-nav.ts`; no protocol/persistence/IO touched.

**Executor behaviour:** honest provenance note and drift list; cited lines verified. Process nit: the branch commit is titled `exec (deepseek)` while the Execution is signed claude-opus-5-5 and says the files predate it — the authoring model of the S5 code is unclear; record it once in the commit/scorecard.
