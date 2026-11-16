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
after the last row — the band's own edge closes it), label `flex: 1`
(never truncated — it WRAPS, and it may shrink: a column that refuses to
shrink pushes a chevron/switch past the row's edge, fix round 1), value `flex: 1`
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

## Execution (slice S6 — drawer UI + navigation, C1)

*— claude-opus-5-5, 2026-11-16 · slice S6 only*

**Scope:** S6 only. No New session pill (S7), no Activity (S8–S10). No
protocol, daemon or client change, so `protocol.json` was not regenerated (no
schema changed).

**Provenance (stated honestly):** at the start of this run the worktree already
held an earlier, unrecorded S6 attempt, uncommitted (mtime 2026-11-16
01:36–01:39): `drawerItems`/`drawerComputers` added to `drawer-list.ts`,
`drawerMotion`/`swipeIsHorizontal`/`swipeCloses`/`DRAWER_WIDTH` added to
`drawer-nav.ts`, a new `drawer-rename.ts`, `screens/SessionsDrawer.tsx`,
`test/drawer-items.test.ts` and `test/drawer-rename.test.ts`. None of it was
wired in, and `SessionsDrawer.tsx` did not typecheck. I checked it against the
plan and the code and kept it with two fixes (below). The wiring, routes, flows,
the magnifier target and all the evidence below are mine.

### Load-bearing check, re-run first (it held)

- The six drawer test files: 50 pass · 0 fail. That includes `drawer-seam`
  (two controllers over two fake `session/list` loaders, no other client call)
  and `drawer-nav` (`drawerTarget` stack).
- The seams are where S5 cited them: `App.tsx` `SessionsRoute` builds its
  controller over `LINKS.get(computerId)` (`:852-854` before this slice's
  edits), `SessionRoute` resolves its own link (`:944`), and the Sessions screen
  opens with `navigate("Session", …)` (`:1651`). The drawer host reuses exactly
  that `load`. **No new client call** was needed; rename uses the existing
  `RemoteClient.rename` (`packages/client/src/remote-client.ts:1215`).

### Drift from the Implementation (each reconciled here)

1. **The host is mounted in `App.tsx`, not in `SessionScreen`.**
   `SessionDrawerHost` (`App.tsx:960`) wraps the Session route's content, so it
   covers both the session screen AND `SessionRoute`'s connecting/error frame.
   The hamburger is in both (`SessionScreen.tsx:421`, `App.tsx:1208`). Mounting
   it inside `SessionScreen` would leave a session that cannot connect with no
   way to the drawer, which is exactly the F2 case. `SessionScreen` only gets
   `onOpenDrawer`.
2. **`onBack` is gone from the Session screen.** The plan says `session-back`
   → `session-drawer`. The chevron is removed, and back is the native edge
   swipe (F1). The connecting frame's leftover `GlassButton` (S2 missed it)
   became a `HeaderIcon` hamburger, so `GlassButton` is no longer imported by
   `App.tsx`.
3. **Flows 24 and 05 never tapped `session-back`** (the plan's Files item 7 is
   wrong). Only the two component sites carried the id. 24 gains a drawer
   shot. 05 gains the F2 drawer check (below), and because the session screen
   has no back button any more, it leaves through the drawer's magnifier.
4. **The magnifier needed a target the plan did not name.** I added
   `drawerSearchTarget(computerId, name)` (`drawer-nav.ts:120`): a reset to
   `[Computers, Sessions{…, search: true}]`. `SessionsRoute` (`routes.ts`) gains
   an optional `search`, and `SessionsScreen` gains `focusSearch` →
   `autoFocus`. A reset, not a push: back from the search lands on Computers,
   not on the session the drawer covered.
5. **Flow 26 is single-computer.** The harness runs ONE `serve`, so the
   cross-computer switch, the computer menu with a second computer, and "back
   lands on the right computer's list" are NOT driven on the simulator. F4's
   stack is pinned by `drawer-nav.test.ts`, and the M1 mutation below shows
   that pin is not vacuous. The edge back-swipe is not driven either: Maestro
   has no iOS edge gesture. The flow's header says this.
6. **The title chevron is always `chevron.down`.** The earlier attempt's
   `chevron.up.chevron.down` (shown while the menu is open) is not in
   `IconName`, and that was the `tsc` error.
7. **A failed probe of the computer rows is swallowed in the host.** The title
   keeps its last rows, or says "Connecting…". The list below reports its own
   failure (F2), so nothing reads as fine.

### As-built

- `App.tsx`:
  - `SessionDrawerHost` (`:960`): `useReducer(drawerReducer)`, plus one
    `createSessionListController` per LISTED computer. It is recreated on a
    menu pick, so a late page of the old one is dropped and the old list never
    shows under the new title.
  - The list and the computer rows (`loadRows`) are re-read on every open (F3).
  - `createDrawerRename` over `LINKS.get(row's computer).client.rename`. A
    success re-reads the list.
  - Everything drawn is computed by `drawerList`/`drawerItems`/`drawerTitle`/
    `drawerComputers`, with `drawerCurrentId` for the highlight.
  - Row tap → `drawerTarget` → `onNavigate`. The `Session` screen maps it to
    `navigation.replace` (same computer) or `navigation.reset` (another computer,
    F4), and `stay` only closes.
  - Settings → `navigate("Settings")`; Pair a computer → `navigate("Pair")`.
- `screens/SessionsDrawer.tsx` (render only):
  - A 300 pt panel. The session is pushed and dimmed with `scrim`, using a
    220 ms `Animated.timing`. Under Reduce Motion it fades instead
    (`drawerMotion`, read live).
  - Closes on a scrim tap, a row tap, a left swipe (`PanResponder`,
    horizontal only), or VoiceOver escape. The panel is
    `accessibilityViewIsModal`, and the session behind it is hidden from
    accessibility while open.
  - Long-press → `ActionSheet` "Rename" → the existing `RenameSheet`.
  - Daemon strings are drawn as plain `Text` only.
- `drawer-rename.ts` (kept): every text decision is `session-rename.ts`'s
  `renamePlan`/`renameErrorText`. A failure keeps the field open with the text
  and the reason (F7). A second Save while saving sends nothing. A success that
  lands after Cancel still refreshes the list (the daemon did rename it).
  I renamed one of its tests, whose name said "does not … refresh" while it
  asserted the refresh.
- Flows:
  - `e2e/flows/26-drawer.yaml` + `.js`, registered in `run.ts` with its own
    session `DRAWER_ID`. The steps: open → current highlighted → shot →
    long-press Rename → switch to `ALPHA_ID` → re-open shows `ALPHA_ID`
    current → scrim closes.
  - It ends on daemon truth: the rename is stored, AND the session that was
    switched away from still exists (F6: detach, never close).
  - `24-ui-shots.yaml` gains the drawer shot. `05-daemon-down.yaml` gains the F2
    check: with `serve` down, the drawer shows `drawer-retry` and NOT
    `drawer-empty`.
- **Red before green:** `drawerSearchTarget` was first written without
  `search: true`. Its test went RED on the assertion (`- "search": true`,
  1 fail), then green. The earlier attempt's pure code had no
  pre-implementation red I could show, so its non-vacuity rests on the
  mutations below.

### Mutation checks (§9: each applied with Edit, the 6 drawer test files run, reverted; final run 51 pass · 0 fail)

| # | Mutation | Caught by (fail) |
|---|---|---|
| M1 | swap `replace`/`reset` (`if (!sameComputer)`) — **plan target** | 4: same computer → replace; other → reset (F4); archived pick; same id other computer |
| M2 | drop the `currentId` match (`current: false`) — **plan target** | 3: seam two-computers; highlight per section; archived auto-expand |
| S6a | a failed read is not an error (`if (false)`) | 1: F2 failed first read is an error, never empty |
| S6c | no list refresh after a rename | 2: success refreshes; answer after cancel still refreshes |
| S6d | a failed rename shows no reason | 2: F7 failure keeps text + reason; MethodNotFound sentence |
| S6e | double Save not guarded | 1: a second Save while saving sends nothing |
| S6f | Reduce Motion still slides | 1: Reduce Motion: fade only |
| S6g | a right swipe also closes | 1: left swipe past threshold closes; right does not |
| S6i | unprobed computer says "Online" | 1: not probed yet says Connecting…, never Online |

(The prepared script `.tentacle/tmp/mobile-chrome/s6-mutations.sh` could not be
run because the shell permission was refused, so I did the same mutations by
hand with Edit.) The plan's third target, the `note.id` join, belongs to S8.

### Gate

- `bun run check` (log: `.tentacle/tmp/mobile-chrome/s6-gate.log`):
  - typecheck (root + `apps/mobile` + `apps/relay`): clean.
  - `biome check .`: 1679 files, no errors or warnings.
  - `bun test`: **12119 pass · 5 skip · 0 fail** (870 files). The skips are the
    same pre-existing opt-in files as S5, none of them in `apps/mobile`.
- **E2E: NOT RUN GREEN. The build is blocked by an issue that predates S6.**
  `bun run e2e:mobile --ios 26 --only 26-drawer,24-ui-shots,05-daemon-down`
  (run `.tentacle/tmp/e2e-mobile/1794791065114`) got through prebuild and
  `serve`/seed, then failed at the Release build. xcodebuild exited 65 with
  `targets/live-activity/LACore/LACore.swift:23:8: error: Unable to resolve
  module dependency: 'PushCore' (in target 'liveactivity')`. S6 touches no
  native/Swift file, so this blocks every flow, not just these three. The
  e2e-flows static test (`test/e2e-flows.test.ts`, 34 pass) accepts the new
  and edited flows. Flows 26/24/05 therefore remain **unverified on a
  simulator**. To verify: fix the `liveactivity` → `PushCore` dependency (a
  separate fix), then re-run the command above, in light and dark.

### Not done in this slice (and why)

- New session pill and its disabled-offline state (F8): S7.
- Cross-computer switch on the simulator: needs a second `serve` in the
  harness (drift 5). Pinned by pure tests only.
- Nothing committed (the orchestrator commits). `TODO.md` untouched.

### Fix round 1

*— claude-opus-5-5, 2026-11-16 · slice S6 · fixes Review round 1 (2 MEDIUM)*

1. **Finding 1, the undisclosed `live-activity/Info.plist`: FIXED.**
   `git cat-file -e main:…/live-activity/Info.plist` reports it is not on
   `main`. Only `notification-service/Info.plist` is tracked there. This file
   is the same `expo prebuild` artifact that S1 removed. S6's failed e2e run
   regenerated it, and the commit swept it in. Fix:
   - The file is deleted from the working tree (`git status`: ` D`).
   - `.gitignore:36-38` now ignores that one path, so a prebuild cannot bring
     it back. It has now leaked twice: S1 and S6.
   - Red/green/mutation, via `git ls-files --cached --ignored --exclude-standard apps/mobile/targets/`:
     - Red, before the rule: empty output.
     - Green, after the rule: `apps/mobile/targets/live-activity/Info.plist`.
     - Mutation, rule commented out: empty again.
     - Reverted: the path is listed again.
   - No unit test was added. A test that asserts the file is absent would fail
     on every local prebuild. The ignore rule is the guard.
2. **Finding 2, flows 26/24/05 not green on a simulator: NOT FIXED (blocked).**
   The block is the `liveactivity` → `PushCore` build error that exists on
   `main`. `LACore.swift:23` has `import PushCore`, and
   `live-activity/expo-target.config.js` declares no package. S1 and S6 each
   rebuilt once and both hit it. Under AGENTS §0 (two strikes) I did not rebuild
   a third time. Fixing the native target is a separate `fix` task, and §10
   allows one code task at a time. **Decision needed from the owner:** either
   open that fix first and then re-run
   `bun run e2e:mobile --ios 26 --only 26-drawer,24-ui-shots,05-daemon-down`
   (light and dark), or accept S6 with the simulator pass deferred.
- LOW items (the `swipeIsHorizontal` vertical case, the rename refreshing the
  current list, the stale header title) were left as they are, since this round
  covers HIGH/MEDIUM only.
- **Gate:** `bunx tsc --noEmit` clean. `bun run lint`: 1679 files, clean.
  `bun test`: **12119 pass · 5 skip · 0 fail** (870 files). That matches the
  S6 baseline, and the skips are the opt-in ones.

## Review

*— claude-opus-5-5, 2026-11-16 · slice S6 only, fresh context (the same model as the executor, so blind spots it shares may survive both passes)*

**Verdict: REQUEST-CHANGES** (2 MEDIUM, 0 HIGH).

1. **MEDIUM: an out-of-scope native file was committed and not disclosed.** `apps/mobile/targets/live-activity/Info.plist` (new in 9d51e996). S1's Execution (around line 837) called this file a stray `expo prebuild` artifact and removed it. S6 commits it, while its Execution says "S6 touches no native/Swift file". *Failure:* the diff ships an undisclosed change to the live-activity target, which is the same target whose build is currently failing (`PushCore`), and it reverses an earlier slice's decision with no reason given. Either drop it, or justify it in Execution (e.g. if it is required the way `notification-service/Info.plist` is tracked on `main`).
2. **MEDIUM: the slice's "done when" is not met.** That row says "flow 26 green both themes; back-swipe lands on the right computer". Flows 26, 24 and 05 have not run green on a simulator (the build is blocked by the pre-existing `PushCore` error). The cross-computer back-swipe is only pinned by `drawer-nav.test.ts`. *Failure:* render-time faults the stripped unit tests cannot see would ship unseen. Examples: the scrim or panel `pointerEvents` after close, `accessibilityElementsHidden` covering the scrim, `autoFocus` on the search reset, or the `replace`/`reset` wiring at `App.tsx` (~`:1888-1897`). The executor disclosed this honestly. It is still owed before S6 counts as done.

**Gate (re-run by me):** the 6 touched test files (drawer-items, drawer-rename, drawer-nav, drawer-list, drawer-seam, e2e-flows) gave 78 pass · 0 fail. `bun run lint` checked 1679 files, clean. `bun run typecheck` (root + mobile + relay) was clean. I did not re-run the full suite.

**Mutations (applied with Edit, reverted, `git status` clean afterwards):**
- `drawerSearchTarget` without `Computers`: caught (1 fail).
- `swipeIsHorizontal` without the `|dx| > |dy|` guard: **survived**. The vertical case in the test, `(-5, 20)`, is below the claim threshold anyway. LOW gap: add a case like `(-20, 40)`.
- The executor's M1/M2/S6a–S6i table was not re-done.

**Attacks tried:**
- (a) F4: a cross-computer pick resets, a same-computer pick replaces, and the same id on another computer gets no highlight (`drawerCurrentId`). Holds.
- (b) F2: daemon down. The list's `LINKS.get` throws, so the list shows an error with Retry. A failed probe of the rows is swallowed, and the title shows its last rows or "Connecting…". It never says "Online" (`drawerTitle`). Holds.
- (c) F7: rename goes to the row's computer (`listed` is captured at `begin`), a failure keeps the field open, and a double Save is guarded. Holds. LOW: `renamed` refreshes whichever list is current, not the computer that was renamed. That list is disposed and re-read on the next pick, so it converges.
- (d) F3: a menu pick recreates the controller and disposes the old one, so a late page is dropped. Holds.
- (e) F6: a switch is `replace`/`reset`, which unmounts and so only detaches. No `session/close` was added. Holds by code; the flow that proves it has not run.
- (f) §7 "logic in pure modules": the branching is in `drawer-list`/`drawer-nav`/`drawer-rename`. The host is wiring only. Holds.
- (g) §7 "a pod is not trusted": daemon strings are drawn as plain `Text`. No protocol or persistence change. Holds.
- LOW: renaming the open session from the drawer leaves the session header's title on the old route param.

**Executor behaviour:** careful and candid. It disclosed the inherited uncommitted attempt, the e2e block and the drift (the host in `App.tsx`, the extra magnifier target). The one miss is the undisclosed `Info.plist`.

### Round 2

*— claude-opus-5-5, 2026-11-16 · reviews 2631546f (`git diff HEAD~1`) only*

**Verdict: PASS.** The code is approved. The simulator pass is still owed and needs the owner's decision (see 2).

1. **Finding 1: FIXED and verified.**
   - `git cat-file -e main:…/live-activity/Info.plist` fails, so the file was never on `main`.
   - The commit deletes the file and ignores that one exact path (`.gitignore:36-38`).
   - Probe: I wrote a temporary file at that path. `git status --ignored` showed it as `!!` (ignored).
   - Mutation: I commented the rule out. The status became `??` (untracked), so the rule is the guard. I restored the rule, deleted the probe, and `git status` was clean.
   - Regression check: the tree now matches `main` for this target, and prebuild still generates the file locally, so nothing is lost.
2. **Finding 2: NOT FIXED, correctly escalated.** Flows 26/24/05 are still blocked by the `PushCore` build error that also exists on `main`. The executor stopped under §0 (two strikes) and named the decision the owner must make: fix the native target first, or accept S6 with the simulator pass deferred. The code needs no further change. S6's "done when" (flow 26 green in both themes) stays unmet until that pass runs.
- **Gate (my run):** `bun run lint` clean (1679 files). `bun run typecheck` (root + mobile + relay) clean. The diff touches no TS, so I did not re-run tests.
- **Regressions:** none. The diff is `.gitignore` + one file deletion + this doc. The new Fix round 1 section sits above `## Review`, which is fine.

## Execution (slice S7 — New session from the phone)

*— claude-opus-5-5, 2026-11-16 · slice S7 only*

**Scope:** S7 only (Files item 8 + the pill). No protocol, daemon or client
change, so there is no `protocol.d/` note and `protocol.json` was not
regenerated.

### Load-bearing check, re-run first: no daemon work needed, but "lazy on first send" does not hold

The probe is `.tentacle/tmp/mobile-chrome/s7-probe.test.ts`. It runs a real
`SessionHost` + `Connection` + `RemoteClient` and the phone's own
`createSessionController`, built as `App.tsx` builds it. Output:

```
A. phone attach-only open of a minted id: {"ok":false,"reason":"link"}
B. after openSeeded (no attach), listed: [true]
C. phone attach after create+detach: true
D. send through the attached handle: ok
```

- **What held:** creating a session needs nothing new from the daemon or the
  protocol. A handle built without `attach` creates the session through its
  `openSeeded()` (`session/open{create}` under a given id,
  `packages/client/src/remote-session.ts:543-584`), and the session is then
  listed.
- **What failed:** the plan says the session is created *lazily, on the first
  send*, but that is not possible on the phone's current path. (A) shows
  why: both of the phone's ways to reach a session only attach:
  - the screen's open (`session-controller.ts` `open`; `App.tsx` `RUNTIMES`,
    `attach: {}`);
  - the outbox's session port (`App.tsx` `outboxOf`, `newSession(…, {attach: {}})`
    then `open()`, which answers null on failure, so the item would wait for
    ever, `outbox-driver.ts:395`).

  A minted id that does not exist yet can never be sent to. Making it lazy would
  mean changing the outbox's persisted item, or a per-id "may create" flag that
  survives an app kill. That is a load-bearing persisted-format change, well
  beyond S.

### Drift from the Implementation (each reconciled here)

1. **The session is created at the tap, not on the first send** (Design 3 "New
   session", Preconditions "New session without new protocol", F8).
   `createFreshSession` (`src/session-controller.ts:123`) does three things in
   order:
   - calls `openSeeded()` on a handle built without `attach`;
   - then detaches that handle and **waits** for the detach, so the screen's
     own attach does not race a detach of the same id in the client's table;
   - then answers `ok`.

   It returns a typed reason (`openFailureReason`) and never throws. After
   that, the Session screen and the outbox work unchanged: they attach to a
   session that now exists.
   - **Cost (owner's call, see Not done):** tapping New session and never
     sending leaves an empty session on that computer. It shows in Recent with
     no title, and is archived by the daemon's idle TTL like any other
     detached session. **And** every create runs the daemon's `admit()`
     (`packages/daemon/src/session-host.ts:1235-1257`): at
     `maxDetachedSessions` it ARCHIVES the detached session idle the longest.
     So repeated taps that are never sent push the person's real older
     sessions into Archived — reversible (reopen), but not reported to them.
     (Corrected in Fix round 1; Review S7 finding 2.)
2. **F8 has a different shape.** The plan said "a failed create on the first
   send surfaces as the composer's send-failure state (outbox keeps the text)".
   Now a create fails at the tap, before anything has been typed. The drawer
   stays open, opens nothing, and shows why (`drawer-new-error`, text chosen
   by the reason code and never taken from the daemon's message). No prompt
   exists yet, so none can be lost. The pill is disabled while the listed
   computer is not online (`drawerTitle(...).canCreate`, from S5). A tap with
   `canCreate` false, or during a create already in flight, sends nothing.
3. **"Composer focused" needed a route param the plan did not name.**
   - `SessionRoute.focus?` (`routes.ts`) and `DrawerPick.focus?`
     (`drawer-nav.ts:52`, passed through on both the replace path and the
     reset path).
   - `SessionScreen` `focusComposer` → `Composer` `focus`. The composer
     focuses the field once, the first time it becomes editable (after the
     attach answers), and never again.
4. **The plan's S7 test "offline → send fails into the outbox (F8)" became
   "offline → a typed `link` refusal, and nothing is created on the
   daemon"**, because the create no longer happens at a send.

### As-built

- `src/session-controller.ts:110-133`: `FreshHandle` + `createFreshSession`
  (the phone's ONE create path).
- `src/drawer-new-session.ts` (new, pure):
  - `createDrawerNewSession({ mint, create, opened })`: one create at a time,
    online only. A failure is kept until the next tap or `dismiss`.
  - `newSessionPill(canCreate, state)` and `newSessionErrorText(reason)`.
  - `NEW_SESSION_TITLE = "(new)"`.
- `App.tsx` `SessionDrawerHost` (`:1059-1092`): `mint` = `crypto.randomUUID`.
  `create` = `LINKS.get(listed)`; a failed dial answers `link`, otherwise
  `createFreshSession(client.newSession(undefined, id))`. `opened` closes the
  drawer and calls `drawerTarget(from, {…, title: "(new)", archived: false,
  focus: true})`. That is the existing replace/reset path, so a create on
  ANOTHER computer resets the stack exactly as F4 does for a row.
- `screens/SessionsDrawer.tsx`: in the footer, Settings on the left and the
  `PillButton` "New session" (`drawer-new`) on the right. A failure line
  (`drawer-new-error`, tap to dismiss) sits above the footer. Render only.
- `e2e/flows/26-drawer.yaml` + `.js`, appended at the end:
  - tap `drawer-new` → `transcript-empty` → text typed with NO tap on the field
    (this proves the focus) → send → `turn-idle`;
  - re-open: a `drawer-current-.*` row (the minted id, matched by pattern) and
    ALPHA back as an ordinary row;
  - daemon truth: `model-prompts` contains the new session's prompt.
- **Red before green:**
  - With the stubs in place (the right signatures, wrong behaviour),
    `drawer-new-session.test.ts` went 8 fail · 1 pass, all on assertions. The
    one pass was the offline test, which passed only because the stub did
    nothing; mutation Md below shows that test is not vacuous.
  - The pill test was 1 fail before `newSessionPill` was implemented.
  - The new `drawer-nav` case failed on the assertion before `focus` was passed
    through (`Expected: true, Received: undefined`).
  - `new-session-link.test.ts` was written after `createFreshSession`, so its
    non-vacuity rests on mutations Ma and Mi.

### Mutation checks (§9: `.tentacle/tmp/mobile-chrome/s7-mutations.ts` applies each, runs the 3 S7 test files, restores; `git status` afterwards shows only this slice's files; the re-run gave 19 pass · 0 fail)

| # | Mutation | Caught by (fail) |
|---|---|---|
| Ma | create skipped (no `openSeeded`). **Plan target:** "creates" | 4, including both real-daemon tests |
| Mb | no detach after the create | 1: creates, THEN detaches, then answers |
| Mc | failure reason not by code (always `link`) | 1: typed reason by error code |
| Md | offline still creates (F8). **Plan target:** "offline" | 1: F8 offline sends nothing |
| Me | double tap not guarded | 1: second tap while in flight |
| Mf | a failed create still opens | 2: F8 failure opens nothing; dismiss |
| Mg | pill enabled while offline | 1: pill enabled only online |
| Mh | a fresh pick drops `focus` | 1: drawer-nav fresh pick |
| Mi | (test-side) create through an ATTACH handle, the phone's current path | 1: the real-daemon test (not created → not listed) |

### Gate

- `bun run check` (from the repo root):
  - typecheck (root + `apps/mobile` + `apps/relay`): clean.
  - `biome check .`: 1685 files, clean.
  - `bun test`: **12148 pass · 5 skip · 0 fail** (874 files). The skips are
    the same opt-in ones as S6.
- The first run had one failure, a source-text guard I broke:
  `session-screen-follow-wiring.test.ts` "Composer: `key={fieldKey}` …".
  It pins `key` then `testID` as adjacent attributes, and my new `ref` sat
  between them. I moved `ref` after `testID` and left the guard as it is.
- **E2E: NOT RUN.** It is the same block as S6: the Release build fails on the
  `liveactivity` → `PushCore` dependency, which also fails on `main` (S6 Fix
  round 1, finding 2). Under AGENTS §0 I did not try a third rebuild. The
  static `test/e2e-flows.test.ts` accepts the edited flow 26 (34 pass). The
  steps added to flow 26 are therefore **unverified on a simulator**. To
  verify: fix the native target, then
  `bun run e2e:mobile --ios 26 --only 26-drawer`, in light and dark.

### Not done in this slice (and why)

- **Owner decision needed:** creating at the tap leaves an empty session if
  the person never sends. The other option is a true lazy create: an outbox
  item flagged "may create", persisted, so that a retry after an app kill
  still creates. That is a persisted-format change and needs its own task.
  Until the owner decides, the tap creates. Weigh in the decision: at the
  daemon's detached cap each abandoned create archives one of the person's
  real idle sessions (Drift 1, cost), silently.
- No "(new)" placeholder row is drawn in the drawer before the first turn's
  title arrives; the daemon's own (empty) title shows there.
- Nothing committed. `TODO.md` untouched.

### Fix round 1

*— claude-opus-5-5, 2026-11-16 · answers Review (slice S7)*

1. **MEDIUM, detach not pinned as awaited — FIXED (test only; the code was
   already right).** `apps/mobile/test/drawer-new-session.test.ts` `fresh()`:
   the fake `detach` now settles a macrotask later (`setTimeout 0`, like an RPC
   round trip) and logs `detach-done`; the ordering test asserts
   `create → detach → detach-done → answered`.
   - **Red (mutation = the reviewer's bug):** `await handle.detach()` →
     `void handle.detach()` in `src/session-controller.ts:131`:
     ```
     error: expect(received).toEqual(expected)
         "detach",
     -   "detach-done",
         "answered",
     (fail) createFreshSession > creates, THEN detaches, and only then answers ok …
      9 pass
      1 fail
     ```
     (Before this round the same mutant gave 0 fail — Review S7.) Reverted with
     Edit; `git diff --stat` then showed only the test file.
   - **Green:** `drawer-new-session` + `new-session-link`: 12 pass · 0 fail.
2. **MEDIUM, cost of create-at-tap understated — FIXED (doc; it stays the
   owner's call).** Verified `admit()` (`packages/daemon/src/session-host.ts:1235-1257`):
   at `maxDetachedSessions` with a persister it archives `selectEvictable`'s
   victim. Drift 1's cost and Not done now state that abandoned creates can
   silently push real idle sessions into Archived. No code change: choosing
   lazy create vs. create-at-tap is the owner decision already open.

**Gate:** `bunx tsc --noEmit` clean · `tsc -p apps/mobile` clean ·
`bun run lint` 1685 files clean · `bun test` **12148 pass · 5 skip · 0 fail**
(874 files; the opt-in skips). E2E flow 26 still not run (same native block).

## Review (slice S7)

*— claude-opus-5-5, 2026-11-16 · slice S7 only · fresh context, SAME model as the S7 executor (shared blind spots possible)*

**Verdict: REQUEST-CHANGES** (one MEDIUM test gap; the code holds).

**Gate (re-run):**
- S7 test files + `drawer-nav` + `session-screen-follow-wiring` + `e2e-flows`: 60 pass · 0 fail.
- `bun run lint`: 1685 files, clean.
- `bun run typecheck` (root + mobile + relay): clean.
- Full `bun test`: not re-run.
- E2E flow 26: not run (the same native-build block as S6), so it is unverified.

**Findings**

1. **MEDIUM: nothing pins that the detach is awaited before ok.**
   - **The gap:** the test is `apps/mobile/test/drawer-new-session.test.ts:41-47`. Its fake `detach` (`:30-31`) logs the moment it is called, before any await. So mutating `await handle.detach()` → `void handle.detach()` (`src/session-controller.ts:131`) still gives 0 fail on both S7 files. Yet the docstring of `createFreshSession` says this ordering is what stops the screen's attach racing the detach.
   - **Failure scenario:** without the await, `session/detach` and the screen's attach-open for the same id go out on one connection. The peer dispatches them concurrently (§7). If the daemon handles the detach second, the phone's attach is undone daemon-side, and the screen shows a session that never streams.
   - **Fix:** in the fake, log a second entry after an awaited deferred, and assert create → detach → detach-done → answered.
2. **MEDIUM (an owner call, not code): the cost of creating at the tap is understated.**
   - **What Execution leaves out:** it says an abandoned session is "archived by the idle TTL". But every create runs `admit()` (`packages/daemon/src/session-host.ts:1234-1256`), and at `maxDetachedSessions` that archives the oldest idle detached session.
   - **Effect:** repeated taps that are never sent push the person's real older sessions into Archived. That is reversible, but it is not reported to the person. It belongs in the owner's decision between lazy create and create at the tap.

**Mutations (mine; `git status` was clean afterwards):**
- Detach not awaited → survives (finding 1).
- Double-tap guard removed → 1 fail.
- Error not cleared on a re-tap → survives (LOW, not reported).

**Attacks tried:**
- **Minted-id collision:** `openSeeded` on a live id ATTACHES (`remote-session.ts:535-541`), but a UUIDv4 makes a collision negligible. Holds.
- **Detach failure:** it is swallowed. `endSession` removes only its own entry (`remote-client.ts:1697`), so the screen's listener survives. Holds.
- **§7 pure modules:** all branching is in `drawer-new-session.ts` / `createFreshSession`, and the components only render. Holds.
- **§7 protocol and persistence:** no wire, schema or disk change, and no second session path (it goes through `RemoteClient`). Holds.
- **§7 pod trust:** the error text is chosen by reason code, never taken from the daemon's message. Holds.
- **Offline:** nothing is sent. Holds.
- **Host unmounted mid-create:** `opened` can still navigate. LOW.

**Executor behaviour:** honest. It found that the plan's premise ("lazy on the first send") was false, did not make a persisted-format change, and documented the drift. Its mutation Mb covered "no detach" but not "detach not awaited", so finding 1 slipped through.

### Round 2

*— claude-opus-5-5, 2026-11-16 · verifies Fix round 1 (`git diff HEAD~1`)*

**Verdict: APPROVE** (S7). Both findings are resolved.

1. **Finding 1: FIXED, confirmed by mutation.** I re-ran the same mutant, `await handle.detach()` → `void handle.detach()` (`src/session-controller.ts:131`). It now gives **1 fail**; before the fix it gave 0 fail. I reverted it, and `git status` was clean afterwards.
2. **Finding 2: FIXED in the doc.** The `admit()` cite (`session-host.ts:1235-1257`) matches the code. The cost of creating at the tap is now part of the owner's open decision. No code change was expected.

**Regressions:**
- The diff touches only the test fake and the doc.
- The detach-failure test still passes: the fake logs `detach-done` before it throws, and `createFreshSession` still swallows the error.
- Double-tap guard mutant: still 1 fail.
- S7 test files: 12 pass · 0 fail. `bun run lint`: 1685 files, clean. `bun run typecheck` (root + mobile + relay): clean.

**Still open:**
- E2E flow 26 has never run on a simulator (the same native-build block as S6).
- LOW, not blocking: error not cleared on a re-tap; host unmounted mid-create.


## Execution (slice S3 — band primitives, E2)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 (tentacle profile `deepseek`), 2026-11-16 · slice S3 only*

> **Signature corrected in fix round 1** (Review round 1, finding 3). This
> section was signed `claude-opus-5-5` while its commit (`7faddece`) is titled
> `exec (deepseek)`. The commit was right: `night-task3.sh:24` runs the S3 step
> through `tentacle --profile deepseek`, and this run's own log carries tentacle's
> tool names (`[tool] fs_read`, `[tool] shell`, `[tool] fs_multi_edit` —
> `runs/night-mobile-chrome-exec.log`), never Claude Code's `Read`/`Bash`/`Edit`.
> The wrong id came from the run's own self-check: it grepped
> `~/.claude/projects/*/*.jsonl`, which is the ORCHESTRATOR's transcript (opus),
> and adopted the model id it found there. The profile's model id is pinned in
> `~/.config/tentacle/config.jsonc` → `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`,
> which is what the signature now says. Nothing else in this section changes.

**Scope: S3 (Band primitives) only.** S4–S10 untouched: no screen was rewired
(`grep` still finds 15 `<GroupedCard`, 10 `<SectionHeader`, 16 `<Row` call
sites in `src/screens` — S4's job), `GroupedCard`/`SectionHeader` still exist,
and no `drawer-*`/`activity*`/`floating-button` file was created. No protocol,
daemon, client or wire change, so `packages/protocol/schema/protocol.json` was
**not** regenerated (`git status` names only `apps/mobile` sources, two test
files, the changelog fragment and this doc). `TODO.md` untouched. Left button is
still "back" (S6).

### Load-bearing check, re-run first (it held)

S3's slice-level assumption: **the four S3 files are sufficient to express every
call site S4 must rewire — no fifth primitive, no new dependency.**

Every site's shape was read before any edit (`.tentacle/tmp/mobile-chrome/s3-repro-before.{sh,log}`):

```
== S3's new modules:
  MISSING src/row-value.ts
  MISSING src/ui/BandSection.tsx
== Row.tsx today:    value slot 0, dot slot 0, ellipsizeMode 0,
                     minHeight = SIZE.rowProject, paddingHorizontal: space.cardInner
== Sheet.tsx today:  backgroundColor: palette.sheet (both branches), xmark 0
== tokens S1 landed: rowList 50, rowX 20, sectionTop 22, band, bandOnSheet, sheet 14
== call sites S4 must rewire: <GroupedCard 15   <SectionHeader 10   <Row 16
== GroupedCard's non-row children (S4 must carry these in a band):
     PairScreen  <View style={styles.hero}>   (a hero tile + button)
     PairScreen  <View style={styles.paste}>  (a TextInput + button)
     SessionInfo <SectionBody>                (a component that renders Rows)
== MISSING test/row-value.test.ts
```

So the capability was genuinely absent. The check **held** with one thing to say:
`PairScreen`'s two "cards" hold a hero block and a paste field, not rows. A band
is a *surface*, so it carries arbitrary children (it only owns the ground, the
hairlines and the label) — no primitive is missing, and S4 reuses `BandSection`
for them with `children` being the existing `View`s. Recorded here so S4 does not
discover it as a surprise.

### Drift from the Implementation (4, each reconciled here)

1. **`rowLayout` was not in the Files list — it took a second input.** Design 4
   asks for "`ellipsizeMode` per value KIND, decided in a pure helper
   `row-value.ts` (`valueEllipsis(kind)`)" and, for F10, "`Row`'s wrap rule, pure
   `rowLayout(fontScale)` **if needed**". Two things forced the second input:
   (a) Design 4 *also* says "a row with a description (Auto-accept) puts it under
   the label, the switch top-aligned" — that is a layout decision at the DEFAULT
   font scale, which a `fontScale`-only function cannot express (mutation 5
   proved it: removing it left the tests green until the property was pinned);
   so `rowLayout(fontScale, { description })` returns `controlAlign` as well as
   `direction`/`valueAlign`/`valueFullWidth`. The component now holds no
   alignment branching at all, which is §7's point.
2. **`Sheet`'s ground is `bg`, not `page`, and `BandSection` reads
   `bandOnSheet`.** Design 4's "the sheet's ground becomes `page`" is the
   *mockup's* variable, not the token: the mockup re-binds `sheet` →
   `bg`-equivalent and `band` → `bandOnSheet` (`index.html:390`), while this
   repo's two palettes both define `page` as the CHAT ground (`#FFFFFF` light,
   `#1F1F1E` dark) and `bg` as the grouped ground (`#F2F2F7` light,
   `#1F1F1E` dark). In light the two differ, and a sheet grounded on `page`
   would have put WHITE bands on `#FFFFFF` — invisible. So: `Sheet`'s full
   (non-floating) ground is `palette.bg` (`#F2F2F7` / `#1F1F1E`) and
   `BandSection onSheet` draws `palette.bandOnSheet` (`#FFFFFF` / `#2A2A28`).
   That is exactly the mockup's result — measured from the rendered page, not
   argued: light `#FFFFFF` bands on `#F2F2F7`, dark `#2A2A28` on `#1F1F1E`
   (`.tentacle/tmp/mobile-chrome/s3-primitives-final.png`, sampled by
   `s3-pixels.py`).
3. **`Row`'s `last` prop was dropped, and `first` now means "no hairline above".**
   Design 4 says the hairline is drawn "between rows inset 20 pt (none after the
   last row — the band's own edge closes it)". The old `Row` drew a TOP-edge
   separator suppressed by `first`, which already satisfies both halves (the last
   row's top line is a line *between* it and the previous row; nothing needs
   suppressing under the last row because nothing is ever drawn there). A `last`
   prop would have been a prop with no drawing behind it, so the interface keeps
   `first` only and the test pins the arrangement (`expect(row).not.toMatch(/last\?:/)`).
   `Row` also gained `value`/`valueKind`/`valueMono`/`dot`/`leading` (Design 4's
   value slot, dot-before-label, and Session info's warning glyph) and LOST the
   `subtitleMono`-driven card inset.
4. **`Row`'s base `minHeight` moved `rowProject` (60) → `rowList` (50).** Design 4
   sets `size.rowList` for a band row; every S4 call site passes its own
   `minHeight` anyway (`rowSetting` 44, `rowSession` 64, `rowAction` 52), so the
   default only matters for the new band rows S4 adds. `space.separatorPlain` /
   `separatorAfterTile` are now unused by the app — left in `theme.ts` (S4's
   delete pass, with `GroupedCard`/`SectionHeader`) rather than removed here,
   because `theme.test.ts` does not pin them and removing a token mid-task is not
   S3's call.

Two smaller things, both recorded so Review can rule: the floating `Sheet`
variant keeps `palette.sheet` (Design 4 only re-grounds a *banded* sheet, and
`Pair`'s compare sheet is a card over a scrim — line 348 of the mockup), and
`Sheet` gained an optional `onClose` (the 18 pt glyph Design 4 asks for) which
**no screen passes yet** — S4 mounts it on Session info.

### As-built, in order

1. **Tests first (red).** New `test/row-value.test.ts` (10 tests) and
   `test/band-wiring.test.ts` (18). Stubbed `row-value.ts` and `BandSection.tsx`
   with deliberately-wrong implementations so the red was on the PROPERTY, not on
   an import: `4 fail` on `row-value` (`Expected: 3 / Received: 1` for the
   per-kind mapping, `Expected: 1.4 / Received: 99` for the threshold) and
   `12 fail` on `band-wiring` (side margin present, no bottom hairline, no
   close glyph, `palette.sheet` not `bandOnSheet`, the old `space.cardInner`…).
2. **`src/row-value.ts` (new, pure).** `valueEllipsis(kind)` — `path` → `head`,
   `model` → `middle`, `text` → `tail`; `ROW_WRAP_AT = 1.4`;
   `rowLayout(fontScale, { description })` → `{ direction, valueAlign,
   valueFullWidth, controlAlign }`, `NaN`/`±Infinity` → the one-line layout.
3. **`src/ui/BandSection.tsx` (new).** Label (12 pt, `sec`, uppercase, `0.24`
   tracking — the mockup's `.02em` at 12 pt, `space.rowX` inset, 6 pt under),
   the full-width square band (`radius.card`, `hairlineWidth` top+bottom,
   `band`/`bandOnSheet` + `sep`/`sepSheet`), an optional footnote.
4. **`src/ui/Row.tsx`.** Full-width 20 pt gutter, `rowList` min height, top-edge
   hairline between rows, dot/`leading`/tile before the label, the label
   `flexShrink: 0` with the 70% cap only while a value shares the row, the value
   right-aligned with `valueEllipsis(kind)` and placed by `rowLayout` (beside or
   under), `alignItems` from `controlAlign`.
5. **`src/ui/Sheet.tsx`.** `bg` ground for the full sheet (`sheet` for the
   floating card), `radius.sheet`, optional 18 pt `xmark` close button, palette
   only (no hex).
6. **`changelog.d/mobile-chrome.changed.md`** — the task's ONE bullet (S2 already
   extended it; `scripts/changelog.ts:125` refuses a second `- ` bullet) gained
   the banded-lists sentence. `CHANGELOG.md`, `TODO.md` untouched.

### Mutation checks (§9 — each applied, run, reverted; full script and output in `.tentacle/tmp/mobile-chrome/s3-mutations.{sh,out}`)

Baseline before each mutation and after each revert: **28 pass / 0 fail** (the
two S3 test files). `git status` after the script names only this slice's files.

| # | Mutation | Result |
|---|---|---|
| 1 | `path` eats its tail (kind ignored) | 3 fail |
| 2 | every kind one constant | 3 fail |
| 3 | `ROW_WRAP_AT` 1.4 → 2.5 (never wraps) | 1 fail |
| 4 | drop the `Number.isFinite` guard | 1 fail |
| 5 | a described row's control back to centred | 2 fail |
| 6 | band gets a side margin back (E1, not E2) | 1 fail |
| 7 | drop the band's bottom hairline | 1 fail |
| 8 | label truncates (`flexShrink: 1`) | 1 fail |
| 9 | row ignores `valueEllipsis` (`ellipsizeMode="tail"`) | 1 fail |
| 10 | row ignores `rowLayout` (magic constants) | 1 fail |
| 11 | the dot moved AFTER the label | 1 fail |
| 12 | sheet keeps its own surface (no banded ground) | 1 fail |
| 13 | close glyph loses its label | 1 fail |
| 14 | sheet corner radius hard-coded 38 | 1 fail |
| 15 | the 70% label cap on the base style | 1 fail |
| 16 | the stacked value dropped (never moved) | 1 fail |

**Three mutations found real vacuities, and they were fixed** — 11, 13 and 14 each
passed on the first attempt: `indexOf("StatusDot")` hit the IMPORT line (so moving
the dot was invisible), `toMatch(/accessibilityLabel/)` matched an empty label,
and `not.toMatch(/radius:\s*\d/)` missed `borderTopLeftRadius: 38`. All three
assertions were rewritten to their real properties (JSX-scoped, non-empty label,
any `*adius:`), and a 15th/16th were added after a later change (the 70% cap, the
value's two placements). The table above is the run AFTER those fixes; every row
is a genuine fail.

### Gate

- `bunx tsc --noEmit` (root) — **clean**.
- `bunx tsc -p apps/mobile --noEmit` — **clean**.
- `bunx tsc -p apps/relay --noEmit` — **clean**.
- `bun run lint` — **`Checked 1689 files. No fixes applied.`** (0 errors, 0
  warnings; AGENTS §6 baseline is clean. My first run flagged 3 format errors in
  my own two test files; `biome check --write` on exactly those fixed them).
- `bun test` (full suite) — **12176 pass, 5 skip, 0 fail** across 876 files. The 5
  skips are the documented opt-in ones; `bun test packages/k8s apps/mobile` shows
  the k8s skip explicitly, and no non-opt-in skip appeared.
- `packages/protocol/schema/protocol.json` — **not regenerated**: no schema changed.

### Not done in this slice (and why)

- **The `done when`'s "primitive-only screenshot" is a mockup-accurate page, not
  a simulator shot.** There is no headless React Native renderer in this repo (no
  `react-test-renderer`, no `react-native-web` in any `node_modules`), and the
  native e2e build is still blocked by the pre-existing `PushCore` error S1/S2
  recorded. So the pixels of the real components are **unverified on a device**.
  What IS verified: every measure the primitives draw with, read from the real
  modules and rendered into a standalone page
  (`.tentacle/tmp/mobile-chrome/s3-primitives.{html,final.png}`, generator
  `s3-primitives-geometry.ts`), then **sampled back out of the PNG**
  (`s3-pixels.py`): light `#FFFFFF` bands on a `#F2F2F7` ground with `#636366`
  labels, dark `#2A2A28` on `#1F1F1E` with `#A3A19B` — E2's "one step above the
  ground" in both palettes, at the real 20/22/50 pt measures. In other words:
  geometry and colours proven, RN's own rendering not seen. S4's flows are the
  first place the real thing is on screen.
- **No screen is rewired** — the slice table's `done when` is the primitive and
  its tests; no screen's structure changes until S4. **But S3 is NOT invisible,
  and my first draft of this line ("S3 alone changes nothing a user can see")
  was false** (Review round 1, finding 2). The 22 live `<Row>` sites render
  through the rewritten `Row` TODAY, inside the 15 `GroupedCard`s S4 has not
  replaced yet, so the current look is an interim, unscreenshotted mix. Measured
  from `git show main:apps/mobile/src/ui/Row.tsx` vs now
  (`.tentacle/tmp/mobile-chrome/f1r1-visible.sh`):
  - the row's own inset widened `space.cardInner` 16 → `space.rowX` 20, so inside
    an un-rewired card the text now sits 16 + 20 = **36 pt** from the screen edge
    (was 16 + 16 = 32), and the hairline inset moved 16/60 → 20;
  - vertical padding 10 → 12 and base `minHeight` `rowProject` 60 → `rowList` 50
    (13 of the 22 sites pass their own `minHeight`, so 9 change height);
  - the title/subtitle **lost `numberOfLines={2}`**: a long session title now
    wraps to any number of lines instead of being capped at two;
  - the separator lost its `icon`-dependent inset (60 after a tile), so a tiled
    row's hairline now starts at the gutter;
  - `Sheet`'s non-floating ground moved `sheet` → `bg`: `SessionInfoSheet` and
    `OutboxDecisionSheet` (neither passes `floating`) go from `#FFFFFF` to
    `#F2F2F7` in light, under `GroupedCard surface={palette.fill}` (`#EFEFF4`)
    cards that still paint the old surface. Dark is unchanged (`#2A2A28` vs
    `#1F1F1E` inside a `pageSheet` Modal whose own ground is `page`).
  So the changelog bullet must not claim a look that is not on screen yet, and
  S4 owns the visible change. Recorded rather than hidden.
- **`PairScreen`'s hero and paste field are not yet in a band** (S4), and the new
  `Sheet onClose` has no call site (S4). `space.separatorPlain`/
  `separatorAfterTile`/`size.rowProject` are now unreferenced by the app,
  deliberately left for S4's delete pass.
- **`band-wiring.test.ts` is a source-reading test** (the repo's established
  pattern for `.tsx`: `header-wiring.test.ts`, `icon-glass-wiring.test.ts`). It
  pins props, tokens and branch structure — it cannot prove RN lays them out
  correctly. The pure decisions it leans on (`valueEllipsis`, `rowLayout`) are
  tested by value in `row-value.test.ts`.

## Review (slice S3 — band primitives, E2)

*— claude-opus-5-5, 2026-11-16 · fresh context, slice S3 only*

**Verdict: REQUEST-CHANGES.**

Gate: `row-value` + `band-wiring` **28 pass / 0 fail**; `bun run lint` clean
(1689 files); `bun run typecheck` clean. Own mutation: `valueEllipsis("model")`
→ `"tail"` ⇒ 2 fail, reverted, tree clean.

1. **HIGH — `apps/mobile/src/ui/Row.tsx:223`** (`text: { flexShrink: 0 }`,
   was `flex: 1`; `textCapped` applies only when a `value` is passed): a row
   whose title is long and which has a `chevron`/`trailing` but no `value`
   (every current call site, e.g. `SessionsScreen.tsx:70-81` with a session
   title, `SessionInfoSheet.tsx:161-172`) lets the label take the full inner
   width and pushes the chevron/trailing past the screen edge. Repro (Yoga,
   RN's layout engine, `.tentacle/tmp/mobile-chrome/s3-review-yoga.ts`, 390 pt
   row, 20 pt gutters, 80-char title, 14 pt chevron):
   `main flex:1 → chevron right edge 370` · `branch flexShrink:0 → 396` (off a
   390 pt screen). S4 keeps this Row, so it is not interim. `band-wiring.test.ts:121`
   pins the buggy property. Fix direction: the label column must still shrink
   against trailing controls (e.g. `flexShrink: 1` + `minWidth` / `flex: 1`
   when no value) — "never truncated" means wrap, not overflow.
2. **MEDIUM — Execution's claim "S3 alone changes nothing a user can see" is
   false.** `Row` (16 live call sites) lost `numberOfLines={2}`, its gutter,
   inset and default height, and `Sheet.tsx:63` re-grounds every non-floating
   sheet (`SessionInfoSheet`, `OutboxDecisionSheet`) from `sheet` to `bg` under
   `GroupedCard`s that still paint `fill`. Merged to `main` per slice, that is a
   visible, unscreenshotted interim look.
3. **MEDIUM — signature.** The Execution is signed `claude-opus-5-5`, but its
   commit `7faddece` is titled `exec (deepseek)`. §10 requires the signature be
   the model that wrote it; one of the two is wrong.

Nits (not blocking): `BandSection.tsx:15,30` still says the sheet ground "becomes
`page`" (Drift 2 chose `bg`); `Row` hairlines always use `sep`, never `sepSheet`
inside a sheet band.

Attacks tried: (a) Yoga layout of label vs chevron — **found #1**; (b) mutation
of the per-kind ellipsis — test holds; (c) surface audit of the Sheet ground vs
the palettes — dark `bg #1F1F1E` / `bandOnSheet #2A2A28` holds, interim
`GroupedCard` mismatch → #2; (d) §7 "logic in pure modules" — `rowLayout`
carries the branching, Row only maps it: holds. No protocol/persistence/runtime
invariant touched. Executor behaviour: scope respected, thorough mutation table,
honest about no device render; over-claimed "no visible change".

### Fix round 1

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 (tentacle profile `deepseek`), 2026-11-16 · answers Review round 1 (slice S3) · my own id, confirmed below*

**Model id provenance (I checked rather than assumed).** My prompt is the
`ds "… fix round $N …"` call at `night-task3.sh:45`, whose `ds()` launches
`tentacle --profile deepseek` (`night-task3.sh:24`); the profile's model is
`rits/deepseek-ai/DeepSeek-V4.1-Flash-1017` (`~/.config/tentacle/config.jsonc`).
I also confirmed the run log this session writes to —
`runs/night-mobile-chrome-fix1.log` — contains my own `f1r1-*` commands, so it
is this session and not a neighbour's. (That is the same check whose absence
produced finding 3.)

#### Finding 1 (HIGH) — `Row.tsx:223` `text: { flexShrink: 0 }` overflowed the row

**FIXED.**

- **Reproduced first**, with Yoga (RN's own engine, through the copy `ink`
  vendors) and the row's REAL style set — 390 pt row, 20 pt gutters, 12 pt gap,
  a 14 pt chevron, an 80-char title. Measured on the shipped code
  (`.tentacle/tmp/mobile-chrome/f1r1-yoga5.out`):

  | case | label | last control's right edge (inner edge = 370) |
  |---|---|---|
  | no value, chevron | 350×44 | **396** — off a 390 pt screen |
  | no value, tile+dot, chevron | 350×48 | **475** |
  | no value, switch | 350×44 | **433** |
  | value + tile + switch | 244×66 | **399** |
  | value, chevron | 244×66 | 370 ok |

  So the bug was wider than the review's case: the cap (70%) only existed on the
  value branch, so every value-less row with a trailing control overflowed, and
  even a capped row overflowed once a tile or a switch joined it.
- **Root cause (one sentence):** the label column refused to shrink
  (`flexShrink: 0`), so it took its MEASURED width and the trailing control was
  pushed past the row instead of the label wrapping.
- **RED first** (§9): 5 fail on the untouched code, on the property, not on an
  import — `row-value.test.ts` ×4 (`labelSizing` undefined) and
  `band-wiring.test.ts` (`flexShrink: 0` present).
- **Fix, in §7's shape (decision in a pure module, component only renders):**
  `row-value.ts` gained `RowLayout.labelSizing: "fill" | "capped" | "stacked"`,
  computed by `rowLayout(fontScale, { description, hasValue })`; `Row.tsx` maps
  it to one of three styles and holds no branching. Base `text` is now
  `{ flexShrink: 1, minWidth: 0 }`; `textFill: { flex: 1 }` (nothing shares the
  line), `textCapped: { flexShrink: 1, maxWidth: "70%" }`, `textStacked`
  unchanged. "Never truncated" is kept where it belongs — the label's `<Text>`
  carries no line cap — and is no longer conflated with "never shrinks".
- **AFTER, styles read back OUT of the shipped `Row.tsx`** (`f1r1-yoga-after.ts`,
  so the measurement cannot drift from the code): every case ends at
  `370/370 ok` — chevron, tile+dot, switch, value+tile+switch, stacked.
- **Drift (1, deliberate):** I deleted `RowLayout.direction`. After the fix
  nothing in `src` read it (only tests), it duplicated `valueFullWidth`, and two
  representations of one fact is exactly the drift class this finding came from.
  Its tests now assert `valueFullWidth`.

#### Finding 2 (MEDIUM) — "S3 alone changes nothing a user can see" was false

**FIXED (doc).** The claim is replaced in **Not done in this slice** with the
measured list (`.tentacle/tmp/mobile-chrome/f1r1-visible.out`): the inset went
16 → 20 (`36 pt` from the screen edge inside an un-rewired card, was 32), the
vertical padding 10 → 12, the base `minHeight` 60 → 50 (9 of 22 live sites
change height), the title **lost `numberOfLines={2}`** so a long title wraps
freely, the separator lost its icon-dependent inset, and `Sheet`'s non-floating
ground moved `sheet` → `bg`, which recolours `SessionInfoSheet` and
`OutboxDecisionSheet` in light (`#FFFFFF` → `#F2F2F7`) under `GroupedCard
surface={palette.fill}` cards that still paint the old surface. The 22 live
`<Row>` sites inside 15 un-rewired `GroupedCard`s are stated as the interim look
it is, and S4 is named as the owner of the visible change.

What I did **not** do: rewrite the changelog bullet. It describes the finished
restyle (an unreleased fragment, assembled at release), and one bullet can only
describe one end state — but Review should know I considered it.

#### Finding 3 (MEDIUM) — signature vs commit title

**FIXED (doc), and it was the opposite of what round 1 guessed.** The commit
title was right and the signature was wrong. Evidence: S3 was launched by
`night-task3.sh:24` (`tentacle --profile deepseek`), and its log
(`runs/night-mobile-chrome-exec.log`) carries tentacle's tool names
(`[tool] fs_read` ×22, `[tool] shell` ×122, `[tool] fs_multi_edit` ×11) — the
deepseek CLI, never Claude Code's `Read`/`Bash`/`Edit`. Its own self-check (`sed
-n '417,432p'` of that log) grepped `~/.claude/projects/*/*.jsonl`, which is the
ORCHESTRATOR's transcript, found `claude-opus-5-5` there, and adopted it. The S3
Execution header now carries the profile's real id plus a note saying exactly
that; the body is unchanged.

#### Nits (were not blocking; both closed)

- `BandSection.tsx:15,30` said a sheet's ground "becomes `page`" — now `bg`, the
  token Drift 2 actually chose and the code actually passes.
- `Row`'s hairlines still paint `palette.sep`, never `sepSheet`, inside a sheet
  band. I checked before changing it and left it: no live `Row` sits on a sheet
  surface today (`SessionInfoSheet`/`OutboxDecisionSheet` still hold
  `GroupedCard surface={palette.fill}` until S4, and `BandSection onSheet`'s
  `sepSheet` edge is the band's own border). In the two palettes `sep` and
  `sepSheet` are identical in light (`#C6C6C8`) and differ by `#3A3936` vs
  `#403F3B` in dark. If S4 mounts banded rows in a sheet, `Row` needs an
  `onSheet`-equivalent then; recorded rather than guessed now.

#### Mutation checks (§9 — each applied, the 2 S3 files run, reverted, `cmp`'d back)

Scripts/output: `.tentacle/tmp/mobile-chrome/f1r1-mutations.{sh,out}` and
`f1r1-mut2.{ts,out}`; backups in `f1r1-bak/`, each restored file verified
`identical to scratch backup`.

| # | Mutation (each is the fix reversed) | Result |
|---|---|---|
| M1 | `text: flexShrink: 1` → `flexShrink: 0` (the original bug) | **1 fail** |
| M2 | `textFill: { flex: 1 }` → `{}` (style exists, no fill) | **1 fail** |
| M3 | the 70% cap leaks onto the base `text` style | **1 fail** |
| M4 | `labelSizing === "capped"` branch wired off | **1 fail** |
| M5 | `rowLayout` ignores `hasValue` (`if (true)`) | **2 fail** |
| M6 | the label regains `numberOfLines={2}` | **1 fail** |
| M7 | the pure module always returns `fill` (cap never applies) | **2 fail** |
| M8 | `textStacked` keeps a 70% cap | **1 fail** |

**Two mutations survived on the first attempt and were real gaps, now closed:**
- M2 — nothing proved that `textFill` *fills*; the test only checked the branch
  was taken. Yoga then leaves the value-less label at its measured width, i.e.
  the overflow again. The wiring test now pins the three styles' geometry.
- M8 — nothing proved the stacked label's full width, so a leftover 70% cap
  would have squeezed it silently. Pinned the same way.
(M6 appears twice in the `.out` files: the `sed` line in the shell script cannot
match across lines and is a deliberate no-op, so the template literal edit in
`f1r1-mut2.ts` is the real M6.)

One further non-vacuity note: `direction`'s deletion is covered by M5/M7 still
biting through `valueFullWidth`, so no assertion was lost with it.

#### Gate

- `bunx tsc --noEmit` (root) — clean.
- `bunx tsc -p apps/mobile --noEmit` — clean.
- `bunx tsc -p apps/relay --noEmit` — clean.
- `bun run lint` — `Checked 1689 files. No fixes applied.` (0/0, matches the §6
  baseline).
- `bun test` (full suite) — **12180 pass, 5 skip, 0 fail** across 876 files, 424 s
  (`.tentacle/tmp/mobile-chrome/f1r1-gate-full.log`). The 5 skips are the
  documented opt-ins; total is +4 over S3's 12176 = the four new `labelSizing`
  tests, and no new skip appeared.
- Files touched: `apps/mobile/src/row-value.ts`, `apps/mobile/src/ui/Row.tsx`,
  `apps/mobile/src/ui/BandSection.tsx` (comments only), the two test files, this
  doc. No protocol/daemon/client/wire change, so `protocol.json` was not
  regenerated; no git checkout/restore/stash/commit was run.

#### Unverified, stated

- **No device/simulator render.** Still the S3/S6 block (no headless RN
  renderer; the native build is blocked by the pre-existing `PushCore` error).
  The fix's geometry is proven with Yoga against the shipped style values, which
  is the engine RN uses, but the real pixels are unseen — the same limitation
  Review accepted for S3.
- **The `sepSheet` nit** depends on S4's final structure (see above).

### Round 2

*— claude-opus-5-5, 2026-11-16 · fresh context, verifies fix commit `44c5fc6c`*

**Verdict: PASS.**

- **Finding 1 (HIGH) — fixed.** The label column now shrinks (`text: { flexShrink: 1, minWidth: 0 }`), and pure `rowLayout(...).labelSizing` (`fill`/`capped`/`stacked`) chooses its width rule. Yoga repro (`s3-review-yoga.ts`): `fill` → chevron right edge **370** (= main), `capped` → 291; it was 396 before the fix. Mutations, each reverted with the tree left clean: base `flexShrink: 0` → band-wiring 1 fail; `textFill` without `flex: 1` → 1 fail; `rowLayout` ignoring `hasValue` → row-value 2 fail.
- **Finding 2 (MEDIUM) — fixed.** The Execution now states that S3 is visible and names S4 as the owner of that change.
- **Finding 3 (MEDIUM) — fixed.** The signature is corrected to the DeepSeek profile and matches the commit title.
- Round-1 nit fixed: `BandSection` docs now say `bg`. The nit about `Row` hairlines using `sep` inside a sheet is still open and not blocking.
- Gate: the two S3 test files pass **32 / 0**; `bun run lint` clean (1689 files); `bun run typecheck` clean. The diff touches no protocol, persistence or runtime path.

## Execution (slice S4 — screens to bands, E2)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 (tentacle profile `deepseek`), 2026-11-16 · slice S4 only*

> **Signature provenance (checked, not assumed — the trap S3 hit).** My first
> draft above said `claude-opus-5-5`; that is the ORCHESTRATOR's model, not mine.
> Evidence for the corrected id: my own process lineage is
> `night-task4.sh mobile-chrome S4` → `tentacle --profile deepseek` → this
> session (`ps -o command= -p $$` and its parents), the profile's model is pinned
> at `~/.config/tentacle/config.jsonc` → `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`,
> and this session's tool names are tentacle's (`fs_read`/`fs_multi_edit`/`shell`),
> never Claude Code's `Read`/`Edit`/`Bash`.


**Scope: S4 (Files item 5) only.** The five screens named by the slice —
`SessionInfoSheet`, `SettingsScreen`, `ComputersScreen`, `SessionsScreen`,
`PairScreen` — became `BandSection`s, and `GroupedCard` + `SectionHeader` are
deleted. S5–S10 untouched: `src/drawer-*`, `SessionsDrawer.tsx`, `App.tsx`,
`src/activity*`, `floating-button.ts` were not opened. No protocol, daemon,
client, persistence or runtime change, so
`packages/protocol/schema/protocol.json` was **not** regenerated. `TODO.md`
untouched.

### Load-bearing check, re-run first (it held)

S3's Execution handed S4 one check: **the S3 primitives + `Sheet onClose`
express every `GroupedCard`/`SectionHeader` call site — no fifth primitive, no
new dependency.** Re-run on the branch before any edit
(`.tentacle/tmp/mobile-chrome/s4-repro-before.{sh,log}`):

```
== primitives on disk          BandSection, Row, Sheet, row-value present;
                               GroupedCard, SectionHeader still present (S4 deletes)
== BandSection props           palette, title (REQUIRED), children, footnote?, onSheet?, testID?
== Sheet: onClose?             45,58,67,72 — declared, drawn, guarded
== call sites                  SessionInfo 2/1   Settings 7/7   Computers 2/0
                               Sessions 2/1      Pair 2/1        (GroupedCard/SectionHeader)
```

So the capability was genuinely absent (15 `<GroupedCard`, 10 `<SectionHeader`,
exactly S3's count) and **it held, with one thing to say**: `BandSection`'s
`title` was REQUIRED, but three of the fifteen sites have no label of their own —
a computer's band is headed by the screen's own name + status line, and the
"Load more" / pair-card bands are single trailing actions. `BandSection`'s doc
already said "a band is a *surface*… it only owns the ground, the hairlines and
the label" (S3's Execution, recorded there so S4 would not be surprised), so the
missing piece was mechanical, not conceptual: `title` became optional and a
label-less band still keeps `space.sectionTop` above it. Recorded as Drift 1
rather than as a new primitive — S3's conclusion stands.

### Drift from the Implementation (5, each reconciled here)

1. **`BandSection.title` optional (was required), and `Sheet.closeTestID` added
   (not in the plan).** Both are the same discovery, from two ends: (a) three
   sites have no section label (above); (b) Design 4 says "`Sheet.tsx` … an 18 pt
   close glyph", and S3's `onClose` derives its id as `${testID}-close` =
   `session-info-sheet-close`, while `25-session-info.yaml:91` taps
   **`session-info-close`**. Renaming the flow's id is a flow edit S6 owns
   (it rewrites 24 and 05), and the id is a flow contract, so `Sheet` takes an
   optional `closeTestID` and Session info passes its existing one. One glyph,
   one id, no flow change.
2. **The scroll variant's close glyph is pinned OUTSIDE the `ScrollView`.** A
   drift I found, not planned: `Sheet`'s scroll branch put the glyph in the
   scrolling content, so on Session info — the one sheet that scrolls — the only
   way out scrolled away. The screen's old 32 pt top bar was fixed, so this would
   have been a REGRESSION introduced by replacing it. The scroll branch now
   renders `{closeGlyph}` after the `ScrollView`, in the sheet's frame, and
   `{scroll ? null : closeGlyph}` keeps it from drawing twice.
3. **Auto-accept is the Session band's LAST ROW, not a second band.** Design 4
   does not mention it; the mockup's `infoE2` (`index.html:394-397`) draws
   Project, Devices, then Auto-accept inside the SAME band, and the row belongs
   to that session's settings. `Section` gained a `lastRow?: ReactNode` prop
   (render-only, no branching) instead of the screen wrapping a second surface
   around it, and the row is handed in gated on `section.id === "session"` — the
   same condition the old block used.
4. **The three dead spacing tokens, plus two more.** S3's Execution left
   `space.separatorPlain`/`separatorAfterTile`/`size.rowProject` for "S4's delete
   pass", and `space.cardInner` became readerless once the five screens moved to
   `space.rowX`. Once the section rhythm moved into the band, `space.sectionSessions`
   and `space.sectionComputers` lost their last readers too (Pair's `block`,
   Settings'/Sessions' `body`/`sections`/`section` gaps, Computers' `section`). All
   six are deleted and `band-screens.test.ts` scans that no `src` file reads them,
   so a future screen cannot reach for the old measure thinking it is the house
   one.
5. **Session info's sheet root re-grounds to `bg`, and its own top bar is gone.**
   Design 4's "the sheet's ground becomes `page`" was settled in S3 as `bg` (the
   grouped ground; `palette.sheet` is `#FFFFFF` in light and would have put the
   bands on their own colour). The screen's root still painted `palette.sheet`
   above the `Sheet`, which in light leaves a white strip at the top safe-area
   inset; it is `palette.bg` now, and the `topBar`/`close` styles went with the
   duplicated glyph (Drift 2).

Two smaller things, both recorded for Review: `Row` gained `onSheet` (the open
nit from S3's fix round 1 — "if S4 mounts banded rows in a sheet, `Row` needs an
`onSheet`-equivalent then": it now paints `sepSheet` for the hairline between two
rows, and every row in Session info passes it), and the voice group's privacy
note stayed the GROUP's own line (`styles.note`, on the band's `rowX` gutter)
rather than becoming the Speaking-rate band's footnote — it covers the whole
group, and it is not gated on `rows.rate` (it was outside every gate before).

### As-built, in order

1. **Tests first (red).** New `test/band-screens.test.ts` (35 tests) — the two
   deleted files, "nothing under `src` imports or renders them", each screen's
   bands, the section notes as footnote(s), the standalone bands, Auto-accept
   inside the Session band, the flow-24/25 testIDs, `Row.onSheet`,
   `Sheet.closeTestID`, the rhythm, and the six dead tokens. On the untouched
   code: **5 pass / 27 fail**, every failure on the PROPERTY (a `GroupedCard`
   tag found, a band absent, a footnote missing, `onSheet` undefined) — never on
   an import or a compile error (`.tentacle/tmp/mobile-chrome/s4-red.log`).
   `band-wiring.test.ts` gained the scroll-variant assertion (S3's file, one
   test, because the property is `Sheet`'s).
2. **`src/ui/Row.tsx`** — `onSheet?: boolean`; the separator's colour is
   `onSheet ? palette.sepSheet : palette.sep`.
3. **`src/ui/BandSection.tsx`** — `title` optional; a label-less band keeps
   `sectionTop`. Doc line about what it replaced flipped to the past tense.
4. **`src/ui/Sheet.tsx`** — `closeTestID`; the glyph hoisted to `head` with
   `{scroll ? null : closeGlyph}`; the scroll branch wraps the `ScrollView` in a
   `scrollBody` frame and renders the glyph after it.
5. **`SettingsScreen.tsx`** — 7 sections → 7 bands, the App-lock notice and the
   error/voice/export banners stay banners (a band holds rows, not notices), the
   three notes became `footnote`s, the privacy note the group's own line.
6. **`SessionsScreen.tsx`** — `Section` → `BandSection title={title}`; "Load more"
   a standalone band; the `section`/`sections` gaps dropped (the band owns them).
7. **`ComputersScreen.tsx`** — each computer's band standalone under its heading
   (the heading took the rhythm: `paddingTop: sectionTop`, `paddingBottom: 6`);
   the pair card a band with the hint as its `footnote`.
8. **`PairScreen.tsx`** — the hero (standalone) and the paste field (its own
   label) as bands; `hero`/`paste` padding `cardInner` → `rowX`; `block` gap
   dropped, the failure banner keeps its own (`insetBlock`).
9. **`SessionInfoSheet.tsx`** — `Section` renders ONE `BandSection onSheet`
   holding the view-model's rows plus `lastRow` (Auto-accept); the section's
   `rowsNote`/`footer`/`switchNote` become its footnote (the switch note keeps
   its testID); every `Row` passes `onSheet`; root → `palette.bg`; the screen's
   own close button deleted in favour of `Sheet onClose` + `closeTestID`.
10. **Deletes.** `src/ui/GroupedCard.tsx`, `src/ui/SectionHeader.tsx`; the six
    dead tokens in `theme.ts`.
11. **`changelog.d/mobile-chrome.changed.md`** — S3 already extended this task's
    ONE bullet (`scripts/changelog.ts:125` refuses a second `- ` bullet); it
    gained the sentence naming the five screens. `CHANGELOG.md`, `TODO.md`
    untouched.

### Mutation checks (§9 — each applied, run, reverted, `cmp`'d back; script and full output in `.tentacle/tmp/mobile-chrome/s4-mutations.{sh,out}`)

Baseline before and after: **54 pass / 0 fail** (`band-screens` + `band-wiring`).
`cmp` against the scratch backups after every revert found no residue.

| # | Mutation | Result |
|---|---|---|
| 1 | `Row`'s sheet hairline goes back to `sep` | 1 fail |
| 2 | `BandSection` always draws its label (no standalone band) | 1 fail |
| 3 | Settings' App-lock note back to a screen `<Text>` (no footnote) | 1 fail |
| 4 | a Settings section keeps a `GroupedCard` | 3 fail |
| 5 | Sessions' "Load more" gets a label of its own | 1 fail |
| 6 | the Computers band gets a `title` (heading doubled) | 1 fail |
| 7 | Computers' hint back to a `<Text>` outside the band | 1 fail |
| 8 | Pair's paste block padding back to 16 | 1 fail |
| 9 | a Session-info band stops declaring `onSheet` | 1 fail |
| 10 | Session info drops `closeTestID` (flow 25 taps nothing) | 1 fail |
| 11 | Session info's root keeps `palette.sheet` | 1 fail |
| 12 | Auto-accept no longer handed to the band | 1 fail |
| 13 | `Sheet`'s glyph ignores `closeTestID` | 1 fail |
| 14 | `theme.ts` brings `cardInner` back | 1 fail |
| 15 | a Settings section loses its band label | 1 fail |
| 16 | the scroll variant puts the glyph back inside the scroller | 1 fail |
| 17 | a wrapper gap comes back above the bands | 1 fail |

**Five mutations found real vacuities and were fixed** — 3, 8, 4, 13 and 16 each
passed on the first attempt:

- **3 and 8** were `some()`/single-property assertions: `some(tag => tag.includes("footnote="))`
  was answered by the two other bands, and only `hero`'s padding was pinned (the
  paste block's could drift). Both rewritten to per-note / per-block.
- **4** was a broken mutation (`scan`-engine sed) rather than a weak test — it now
  swaps a band for a `<GroupedCard>` and fails 3 tests.
- **13** was untested at all: `closeTestID` was declared and read, but nothing
  asserted the read, so a rename would have silently broken flow 25. A test pins
  `closeTestID ?? (testID === undefined`.
- **16** was the assertion I had just written, and it was wrong: it scanned the
  scroll branch, where the frame's copy sits AFTER the `ScrollView` (correct) —
  so re-rendering the glyph in `head` left it green. It now also pins the
  `{scroll ? null : closeGlyph}` guard in `head`, which is the property that
  actually protects against a doubled glyph.

### Gate

- `bunx tsc --noEmit` (root), `bunx tsc -p apps/mobile --noEmit`,
  `bunx tsc -p apps/relay --noEmit` — **all clean** (`TSC-ALL-OK`, exit 0).
- `bun run lint` — **`Checked 1693 files. No fixes applied.`** (0 errors, 0
  warnings; AGENTS §6 baseline is clean, so no new issues). My first runs flagged
  format errors in my own test file and one stray `;;` in PairScreen's imports;
  `biome check --write` on exactly those fixed them.
- `bun test` (full suite) — **12274 pass, 5 skip, 0 fail** across 880 files
  (`.tentacle/tmp/mobile-chrome/s4-gate.log`). The 5 skips are the documented
  opt-in ones (live-k8s ×2, live-docker ×2, real-socket slow test); no non-opt-in
  skip appeared.
- `apps/mobile` alone — **1944 pass, 0 fail** across 143 files.
- `packages/protocol/schema/protocol.json` — **not regenerated**: no schema changed.

### Not done in this slice (and why)

- **Flows 24 and 25 were not run on a simulator** — the `done when` names them,
  and the iOS e2e build is still blocked by the pre-existing `PushCore`
  resolution error S1/S2/S3 recorded. So "the bands look right on glass" is
  **owed, not proven**. What IS verified: every testID those two flows assert
  still exists in `src` (`export-logs`, `lock-delay-*`, `open-settings`,
  `settings-back`, `computers-list`, `computer-<id>`, `sessions-search`,
  `sessions-no-match`, `session-<id>`, `pair-paste-input`, `pair-paste-submit`,
  `pair-review`, `pair-sas-*`, `session-info-sheet`, `session-info-close`,
  `session-info-model-*`, `session-info-mcp-*`, `session-info-skills-*`,
  `session-info-mcp-demo-switch`, and S6's `session-drawer`/`drawer*`), and the
  structure each of them is drawn by is pinned by `band-screens.test.ts`. To
  verify: `bun run e2e:mobile --ios 24 && … 25` once `PushCore` resolves, and read
  the shots against mockup row D (`index.html` `infoE2`/`settingsE2`).
- **No screenshot of the five screens.** Same blocker; the visual check the slice
  table asks for ("standard Review + visual check vs row D") is the reviewer's to
  run, and this slice cannot invent one.
- **The drawer's own lists are not banded** — Design 4 says so explicitly ("The
  drawer is NOT banded"), and S6 has not landed its UI yet.
- **`SessionInfoSheet`'s `styles.section`/`sectionGroup` are now `gap: 0`
  wrappers.** They are kept because `view.sections.map` needs a per-section key
  holder, not because they space anything; a future pass can fold them once the
  map is rewritten.

## Review

*— claude-opus-5-5, 2026-11-16 · slice S4 only, fresh context (different model family from the deepseek executor)*

**Verdict: REQUEST-CHANGES** (1 MEDIUM).

**Gate (re-run):** band-screens + band-wiring + e2e-session-capabilities: 58 pass / 0 fail; `bun run lint` clean (1693 files); `bun run typecheck` OK. I did not re-run the full suite.

**Findings**

1. **MEDIUM — a section's notes run together into one line.** Code: `SessionInfoSheet.tsx:244-274` and `BandSection.tsx:67-73`. `Section` passes the notes as a Fragment of `<Text>`s. `BandSection` puts that Fragment inside its own footnote `<Text>`. React Native lays out a `<Text>` nested in another `<Text>` inline, with no break between them. Before S4, each note was its own paragraph. Example: the MCP section always has a `footer` (`session-info.ts:687`) and may also have a `switchNote` (`:689`), so it now reads "1 of 2 connected" followed straight by the switch note, with no space. The Skills section can join three notes this way ("and 3 more" + "N skipped" + the switch note, `:797-802`). A second problem comes with it: a nested `<Text>` is a virtual text node on iOS, so the `session-info-switch-note-*` testID matches no view. The tests did not catch this because they scan the source text and never lay anything out, so the mutation-based checks cannot see it either. Fix: let `BandSection` take a non-string footnote as a `View`, or have each note render as its own block. Then add a test that pins one block per note.

**Attacks tried**
- Mutation: I removed the `{closeGlyph}` that the scroll variant pins outside the `ScrollView`. The band-wiring test failed (1 fail), so that test does detect the change. I reverted the edit with `Edit`, and `git status` showed the tree clean afterwards.
- Flow contracts: flow 25 still taps `session-info-close`, through `closeTestID` on `Sheet`. No flow references the switch-note id.
- Auto-accept moved into the Session band as its last row. It no longer passes `first`, so it draws a hairline between itself and the row above, which is correct. It shows on the same condition as before (`section.id === "session" && autoAccept`).
- §7 invariants: S4 only touches rendering. It has no protocol, persistence, RPC or broker reach, and puts no new logic in a component apart from the `notes` filter, which is trivial.
- Small items, not findings: the root dropped `paddingTop: insets.top`, which was the old top bar's inset (please confirm on a device). `BandSection.tsx:4` duplicates the "label, then ONE full-width surface" line in its doc comment. Two notes with identical text would get duplicate React keys.

**Unverified:** I did not run flows 24/25 or take screenshots, because the PushCore blocker recorded in Execution still stands. So the visual check against row D is still owed.

**Executor behaviour:** Honest and thorough. It recorded its drift openly, fixed the five vacuous tests its own mutations exposed, and was clear about what it had not verified. Its gap is the one in finding 1: every test reads the source, none renders, so a layout regression gets through.
