# feat/mobile-hub — the floating button becomes the hub: a long-press radial fan

> **Status:** implementation — **approved by owner delegation (2026-11-16)**; the surface (radial fan) is the owner's own binding choice
> **Branch:** `feat/mobile-hub`
> **Size:** L (split into four S/M slices) · **Blast:** contained (iPhone app only, behind the default-off "Floating" setting; no protocol, daemon or persistence change) · **Suited:** strong model for the gesture machine + UI (H1, H3), weaker model for the pure action list + late wiring (H2, H4); mandatory fresh-context Review (size L, AGENTS §10)
> **Changelog:** `changelog.d/mobile-hub.added.md` — `- **The floating button is now a hub.** On the iPhone, with Settings → Activity button → Floating, long-press the button: a fan of actions opens around it (Stop, Steer, Activity, Artifacts, Attach, Sessions…). Slide to one and let go, or let go first and tap. Tap still opens Activity. VoiceOver gets the same actions from the rotor.`

## Context

*— claude-opus-5-5, 2026-11-16*

**The ask (owner, 2026-11-16).** "Integra artefatti nel bottone flottante,
quel bottone sarà il nostro coltellino svizzero; rendiamolo anche vibrante al
lungo contatto che apre un modal o simile se serve, pensiamo e portiamo al
massimo la UI/UX." Then, binding (~00:45): "Ventaglio attorno al bottone —
tanta roba, mi piace; se fai un ottimo lavoro vai di quello con
l'implementazione." The owner delegated every other decision for the night
and reviews in the morning. The mockups must keep the alternatives on screen.

**Where we start.** The floating Activity button is designed in
`docs/feat/mobile-chrome.md` Design 6 (`:341-380`). It is opt-in: Settings →
Activity button: "Header" (default, owner F1) / "Floating" (F2,
`:691-698`). Its rules live in a pure `floating-button.ts`: `snap`, `place`,
`isTap` (a press that moved < 6 pt and lasted < 300 ms is a tap; anything
else is a drag, `:358-359`), `visible` (shown only while something runs,
hidden at zero, `:360-362`), `motion`, `a11y`. It is slice S10
(`:626`). **S10 is not built yet.** `main` has merged mobile-chrome S1
only (`git log main`: `4164c835 Merge branch 'feat/mobile-chrome'`;
`apps/mobile/src/ui/` has no `FloatingActivity.tsx`), and the
`feat/mobile-chrome` worktree has no floating file either. So this plan is
written against the S10 *design* and **starts only after mobile-chrome
merges whole (S1–S10)** (AGENTS §10: one code task at a time).

**What the hub must reach** (and which task owns each target; we call their
entry functions and never re-implement them):

| Action | Owner task / where it lives today | Entry the hub calls |
|---|---|---|
| Stop the turn | composer, on `main` | the composer's own stop branch, `session-screen-controller.ts:821-829` (`ownControl.abort()` / `foreign.cancel()`), via a new `stopTurn()` (H3) |
| Steer | composer, on `main`: typing while a turn runs queues a steer (`composer.ts:90-95`, `session-screen-controller.ts:814-819`) | focus the composer field |
| Activity | mobile-chrome S8/S9 (Activity sheet) | the sheet's open callback (S8) |
| Artifacts (+ unseen count) | feat/model-artifacts — **no doc yet** (its worktree is at `c90f0729`, no `docs/feat/model-artifacts.md`) | its gallery open + `unseen` count, when merged (H4) |
| Scheduled wakes | feat/cron-tool: `schedules` update (`cron-tool.md:290-300`), iPhone Session-info section M7 (`:405-432`) | Session info scrolled to SCHEDULED WAKES, when merged (H4) |
| Session info / capability toggles | `SessionInfoSheet` on `main` (`SessionScreen.tsx:701-719`); MCP/skills switches from feat/session-capabilities (`session-capabilities.md:269-274`) live inside it | `setInfoOpen(true)` + `controller.openInfo()` (`SessionScreen.tsx:687-691`) |
| Attach | composer photo chooser on `main` (`SessionScreen.tsx:647-653`, `controller.pickPhoto`, `session-screen-controller.ts:259`) | the same chooser, extracted to one function |
| Dictate (Beta) | feat/mobile-voice-hidden: shown only when `settings.dictation` (`mobile-voice-hidden.md:32-33`) | `voice.tapMic()` (`SessionScreen.tsx:645`) |
| Sessions / New session | mobile-chrome S6 drawer, S7 New session | drawer open / `onNewSession` |

**Constraints.** Owner taste: minimal, thin SF-style glyphs, no rounded inset
cards, no pure black, the approved mobile-chrome look (light + B1 warm
graphite). `expo-haptics ~58.0.8` is already a dependency
(`apps/mobile/package.json:22`); `haptics.ts:9-20` is the only file that
touches it, `haptic-rules.ts:8` decides when (`light | firm | success`
today). No gesture library is installed (S10 uses core `PanResponder`,
`mobile-chrome.md:373`); we keep it that way.

**Mockups** (mandatory, owner: "fammene sempre un paio"):
`.tentacle/tmp/mobile-hub/mockups/index.html` (gitignored, AGENTS §6). It is
self-contained, has a light/dark toggle, and uses the mobile-chrome tokens.
21 iPhone frames:
- **A · radial fan — CHOSEN (OWNER)**: idle with badges; pressed + haptic
  cue; sliding with the item under the finger magnified; released → commit;
  lift-then-tap; left edge near the header; bottom of the band (two rings);
  keyboard up.
- **B · vertical stack — alternative**, 4 states.
- **C · bottom-sheet grid — alternative**, 4 states.
- **D**: tap → Activity; running turn (Stop first); More menu; VoiceOver
  menu + rotor; header mode (the default, unchanged).

The fan positions are computed in the page by the **same solver** this plan
specifies (Design §3), so the render-check also checks the geometry.

**Repro / render-check** (2026-11-16, `bun .tentacle/tmp/mobile-hub/render-check.ts`;
it evaluates the page's script against a stub `document`, renders light,
toggles, renders dark, then sweeps the solver):

```
[light] body=light frames=21/21 missing=[] bad-words=[] chosen-tags=12 alt-tags=8
  fan-3-slide: fan 1 ring(s) R=96 items=6/6 clipped=0 minGap=56.0pt
  fan-4-release: fan 1 ring(s) R=96 items=6/6 clipped=0 minGap=56.0pt
  fan-5-sticky: fan 1 ring(s) R=96 items=6/6 clipped=0 minGap=56.0pt
  fan-6-left-top: fan 2 ring(s) R=88+144 items=6/6 clipped=0 minGap=56.0pt
  fan-7-corner: fan 2 ring(s) R=88+144 items=6/6 clipped=0 minGap=56.0pt
  fan-8-keyboard: fan 2 ring(s) R=88+144 items=6/6 clipped=0 minGap=56.0pt
  running-turn: fan 1 ring(s) R=96 items=6/6 clipped=0 minGap=56.0pt
[dark] body=dark frames=21/21 missing=[] bad-words=[] chosen-tags=12 alt-tags=8
  (same seven geometry lines as light)
[sweep] cases=1008 oneRing=944 twoRings=64 menuFallback=0 clipped=0
RENDER-CHECK OK
```

The sweep covers both edges × yFraction 0…1 (step 0.05) × 1–6 items ×
keyboard down/up × 390×844 and 375×667 (SE) bands. Bands shorter than
2 × 54 pt are skipped: the button is hidden there (mobile-chrome F20). The
first single-ring attempt (one ring, R ≤ 148) did **not** fit six items at
the bottom of the band (hand-computed: about a 94° window against a 97° span).
That is why the solver has a two-ring step. A doc-only fan would have
shipped clipped.

## Implementation

*— claude-opus-5-5, 2026-11-16*

### Load-bearing assumption

**Press-slide-release works on the core RN responder with no gesture library.**
Once the hub button's `PanResponder` is granted on touch-down, it keeps
getting `move` and `release` for that touch after the finger leaves the
button's 54 pt frame. It can also refuse to yield
(`onPanResponderTerminationRequest: () => false`), so the fan items never
need their own touch handlers during the press. They are hit-tested in pure
code from the raw page point. This is documented `PanResponder` / Gesture
Responder System behaviour. The app's `node_modules` is not installed in
this worktree, so it is **not proven here by `file:line`**. Because of that,
**H3 step 1 is a 20-line on-device spike** that logs `move` page-points and
release while sliding 150 pt away from a 54 pt view, sitting as a sibling
above a `ScrollView`. It also checks that the `ScrollView` does not scroll
and that the responder is not terminated. If this fails, STOP and fix the
plan (fallback: `react-native-gesture-handler`, a new dependency → owner).
A second fact rides on it: **the hub is a sibling overlay of the transcript,
not its child** (S10 mounts it "above the transcript", `mobile-chrome.md:374-376`).
So UIKit hit-testing never routes the touch into the `ScrollView`'s pan
recognizer, and the scroll cannot steal it.

### Preconditions

- **P1 — mobile-chrome merged whole**, in particular S6 (drawer), S8/S9
  (Activity sheet, `activity.ts` count), S10 (`floating-button.ts`,
  `FloatingActivity.tsx`, `activity-settings-store.ts`, the Settings row;
  `mobile-chrome.md:424-429`). The executor re-checks `git log main` and
  STOPS if S10 is absent.
- **P2 — Stop's semantics already exist and stay one path**:
  `composerAction` yields `stop` only when the text is blank, a turn runs and
  the link is up (`composer.ts:90-97`). The hub's Stop must not depend on the
  draft. So `stopTurn()` asks `composerAction({...input, text: "", photos: 0})`.
  That is the same truth table with nothing to send. It acts only on
  `kind === "stop"`, through the same `ownControl.abort()` /
  `foreign.cancel()` lines (`session-screen-controller.ts:824-829`). This is
  not a second stop path.
- **P3 — haptics seam**: `playHaptic(kind)` swallows failures
  (`haptics.ts:13-19`); the kinds are a union in `haptic-rules.ts:8`. The new
  kinds are added there, played there, and decided by pure rules.
- **P4 — plain menu exists**: `ui/ActionSheet.tsx` (used at
  `SessionScreen.tsx:676-700`) is the "More" and VoiceOver menu, so no new
  menu component is needed.
- **P5 — sheets are already state on the Session screen** (`menuOpen`,
  `infoOpen`, `renaming`, the permission sheet, the outbox decision;
  `SessionScreen.tsx:664-726`). "Any sheet open" is computable for the
  visibility rule.
- **P6 — an action whose task is not merged is absent, never a dead button.**
  The hub's action list is built from an `entries` record of callbacks. A
  missing callback means a missing action. Artifacts waits for
  feat/model-artifacts. Scheduled waits for feat/cron-tool S6 (and is shown
  only when the daemon sends `schedules`). Dictate waits for
  feat/mobile-voice-hidden and `settings.dictation`. Sessions / New session
  wait for chrome S6/S7, which P1 covers.

### Design

**1. Semantics: tap, long-press, drag (one pure state machine, `hub-gesture.ts`).**
Thresholds (constants, exported, pinned by tests):
`SLOP = 10 pt` (UIKit's `allowableMovement` default), `LONG_MS = 400`.

| What the finger does | Result |
|---|---|
| Released before 400 ms, total travel < 10 pt | **tap** → Activity sheet (S10's meaning kept; muscle memory) |
| Travel ≥ 10 pt before 400 ms | **drag** → reposition (S10 snap), never opens the fan |
| Held 400 ms with travel < 10 pt | **fan opens** (haptic `open`); from now on movement is *selection*, never drag |
| Fan open, finger on an item (sector rule below), released | **commit** that item (haptic `commit`) |
| Fan open, finger moved past `SLOP` and released on no item | **cancel** (no haptic) |
| Fan open, released having moved < `SLOP` since the open | **lift-then-tap**: fan stays open; a tap on an item commits, a tap elsewhere (or on the button) closes |
| System cancel (call, app background, sheet arrives, VoiceOver turns on) | cancel, no haptic |

This **replaces S10's `isTap`** (6 pt / 300 ms). A 300–400 ms still press is
now a tap instead of "neither", and the tap slop grows 6 → 10 pt. `isTap`
stays as a thin wrapper over `classifyPress` so S10's tests keep their names.
Their numbers are updated in H1 and the change is recorded in Execution.
The machine is `reduce(state, event) → {state, effects[]}`. Events:
`down(p,t)`, `move(p,t)`, `timer(t)` (the component arms one 400 ms timer and
feeds it), `up(p,t)`, `cancel`, `tapOverlay(p)`. States: `idle`,
`pressing`, `dragging`, `fanTracking{hi}`, `fanSticky`. Effects: `haptic`,
`open(layout)`, `highlight(i|null)`, `commit(id)`, `close`, `dragTo(p)`,
`drop(p)`.

**2. Haptics** (expo-haptics; `haptic-rules.ts` gains the kinds, `haptics.ts` plays them):
- open (400 ms reached) → `firm` = `ImpactFeedbackStyle.Medium`: the "lift",
  like the system context menu's;
- each change of highlighted item to a non-null item → new `tick` =
  `Haptics.selectionAsync()`. It does not fire when the highlight clears:
  silence means "nothing";
- commit → new `commit` = `ImpactFeedbackStyle.Rigid`: crisper and firmer
  than the tick;
- cancel, sticky open, drag → nothing (drag start already has the visual
  lift; fewer buzzes = more meaning);
- "More"/menu choice → `light`.

**3. Fan geometry (pure `hub-fan.ts`).**
`fanLayout({anchor, edge, bounds, n}) → {kind:"fan", rings, items[{x,y,angle,R}]} | {kind:"menu"}`.
`bounds` = the measured band: header bottom, composer top (or keyboard top),
screen left/right minus safe-area insets. These are the **same measured
bounds S10's `snap` uses**, so the header, composer, keyboard and home
indicator are inputs, not guesses. Items are 48 pt circles (≥ 44 pt target),
centre-to-centre ≥ 56 pt, 8 pt padding from every bound.
1. θ₀ = the angle from the button centre to the band centre (it points
   inward from either edge and bends down near the header, up near the
   composer).
2. **One ring**: for R = 96…148 (step 4), the item step is Δ = 2·asin(28/R).
   Search the arc centre θc outward from θ₀ in 1° steps, both ways, and take
   the first θc where all n items are inside. The smallest R wins (shortest
   thumb travel).
3. **Two rings** (when 2 fails, typically the bottom or top of the band):
   inner ring ⌈n/2⌉ items at R₁ = 88…120, outer ring the rest at R₁ + 56,
   same θc search.
4. Nothing fits → `{kind:"menu"}`: the plain `ActionSheet` with the same
   items. The fan is never clipped; the sweep above found 0 such cases on
   two phone sizes, but the branch exists and is tested.
- **Order**: item 0 sits at the arc END nearest the composer (the end with
  the larger y) = the shortest travel for a thumb that rests low, and the
  rest follow along the arc. With two rings, the inner ring holds the
  top-priority half. *(Corrected in H1: an arc that passes straight down —
  six items high in the band — has a lower item in its middle, so "item 0
  has the largest y" is false in 34 of the 1008 sweep cases; the solver, the
  same as the mockup's, keeps arc order so priorities stay contiguous.)*
- **Selection** (`pickItem(layout, point, prev)`): the angular sector around
  the anchor, active between 0.45·R and R + 56 pt (two rings: the radius
  picks the ring). Hysteresis: a neighbour wins only past the midpoint + 4°,
  so the highlight never flickers. Inside 0.45·R or beyond the outer limit
  → null. In sticky mode an item is hit within 30 pt of its centre.
- **Label** (`labelPlacement`): only the highlighted item has a label pill.
  It sits on the inner side (left of the item for a right-edge button) and is
  clamped to the screen, else placed above the item. Its width comes from the
  measured text (Dynamic Type), so it never truncates; at accessibility
  sizes it may wrap to two lines.

**4. Motion.** Items spring out from the button centre, staggered 18 ms each
(scale 0.4 → 1, opacity 0 → 1; `Animated.spring` damping 18, stiffness 260;
all six done ≈ 200 ms). The highlighted item scales to 1.3 (spring, 120 ms),
the others dim to 0.55. A light scrim dims the screen (light 0.12,
dark 0.30). Commit/cancel collapse the items into the button (120 ms).
**Reduce Motion**: no spring, no stagger, no scale animation. Items fade in
together (120 ms), and the highlight is the accent fill without growth. This
comes from S10's `motion(reduceMotion)`, extended to `fanMotion(reduceMotion)`,
read live from `AccessibilityInfo` change events (mobile-chrome F23).

**5. Actions and order (pure `hub-actions.ts`).**
`hubActions(ctx, entries) → {fan: HubItem[] (≤ 6), more: HubItem[], all: HubItem[]}`.
The canonical order is stable, and context only *prepends* the turn pair:
- **Turn running** (`turn !== null`, link up): `Stop`, `Steer`, then the
  canonical list.
- **Canonical**: `Attach`, `Activity`, `Artifacts`, `Sessions`,
  `Session info`, `Scheduled`, `Dictate (Beta)`, `New session`.
- An item is present only if its entry exists (P6) and its condition holds:
  Attach only if the session is editable (`state.view.editable`); Scheduled
  only if `schedules.length > 0`; Dictate only if `settings.dictation`;
  Stop/Steer only while running (Stop needs `stopTurn()` to resolve to
  `stop`, i.e. link up).
- **Badge promotion**: an item with a badge (Artifacts unseen > 0, Scheduled
  due within 10 min) may move up to the first canonical slot that has no
  badge, so new things are reachable. It never moves past the turn pair.
- **Six visible**: if `all.length ≤ 6`, `fan = all`. Otherwise `fan` =
  the first 5 + `More`, and `more` = the rest in the same order. Stable
  identities keep their relative order in every context (muscle memory). The
  only shifts are the prepended turn pair and badge promotion. Both are
  visible: labels magnify and badges show.
- **Commit is re-validated** (`resolveCommit(id, ctxNow)`). The layout is a
  snapshot taken at open; the world is read again at release. Stop when the
  turn has already ended → no-op + the notice "Already finished". Attach on
  an ended session → no-op. Artifacts with the method gone → its entry's own
  error.

**6. The button: badges and visibility (`floating-button.ts`, extended).**
- **One badge at most**:
  - a number = background activity running (`activity.ts` count, S8);
  - else a dot = unseen artifacts or an unread report.
  - A thin accent arc spins around the button while the turn runs (it is
    not a badge, so it can't clutter). The idle glyph is a thin 2×2 dot
    grid ("hub").
  - `accessibilityLabel`: "Tentacle hub, 2 running, 3 new artifacts"
    (`hubA11yLabel`).
- **Visibility changes (the hub must stay reachable).** In "Floating" mode,
  S10's `visible` hid the button at zero activity. Now it is **shown
  whenever the Session screen is up**, except:
  - while the drawer or any sheet is open (P5);
  - while the band is shorter than 2 × 54 pt (keyboard on a small phone,
    F20).
  At zero activity it shows the idle glyph with no badge. Sheet open or
  drawer while the fan is open → `cancel` immediately (no haptic). The fan
  never sits over a sheet.
- While the fan is open (tracking or sticky): `navigation.setOptions({gestureEnabled: false})`
  so the native back-swipe cannot start under the scrim. It is restored on
  close. Keyboard: opening the fan does **not** dismiss the keyboard. Attach
  and Steer act with it up; Steer focuses the field.

**7. VoiceOver (an accessible equivalent, never the fan).**
- With VoiceOver on, the button is not draggable and sits in the reading
  order (S10 a11y rule, `mobile-chrome.md:365-370`).
- Activate (double-tap) = tap = Activity.
- It exposes `accessibilityActions` = `all` (no six cap) + "Show all
  actions", handled by `onAccessibilityAction`. VoiceOver users reach them
  with a swipe up/down on the Actions rotor.
- Double-tap-and-hold (a long-press under VoiceOver) opens the plain
  `ActionSheet` with `all`. The fan never opens under VoiceOver.
- `accessibilityHint`: "Double-tap for Activity. Swipe up or down for more
  actions."
- The header pill is also drawn while VoiceOver runs (S10 F23 kept).

**8. One-handed reach, Dynamic Type, dark/light.**
- The default rest position (S10) is the right edge at yFraction 0.72,
  inside the natural thumb arc of a right hand. Item 0 has the shortest
  travel.
- Left-handed users drag the button to the left edge, and the fan mirrors
  (frame A-6).
- Dynamic Type grows the label pill, not the 48 pt items. With an
  accessibility text size the label wraps; the fan geometry is unchanged.
- Colours come only from `palette` tokens (`glass`, `glassBorder`, `accent`,
  `red`, `scrim`; `theme.ts:60-67`), so dark (B1) and light follow the theme.
  Stop is the only red item.

**9. Header mode (default) — unchanged.** The hub lives only in "Floating"
mode. Header-mode users keep the pill (tap → Activity), attach in the
composer and sessions behind ☰. Nothing is lost; this task adds nothing
there (see Q-H1).

### Files

Dependency order; all in `apps/mobile`. [slice] in brackets.

1. `src/hub-gesture.ts` (new, pure): constants `SLOP`, `LONG_MS`; `classifyPress`;
   `reduce` (the machine of Design 1) [H1].
2. `src/hub-fan.ts` (new, pure): `fanLayout`, `pickItem`, `labelPlacement`,
   `fanMotion` [H1].
3. `src/floating-button.ts` (S10's): `isTap` → wrapper over `classifyPress`;
   `visible` → the Design 6 rule [H1].
4. `src/hub-actions.ts` (new, pure): `HubActionId`, `hubActions`,
   `resolveCommit`, `buttonBadge`, `hubA11yLabel` [H2].
5. `src/haptic-rules.ts` (+ `tick`, `commit` kinds, `hubHaptic(effect)`);
   `src/haptics.ts` (play `selectionAsync`, `Rigid`) [H2].
6. `src/session-screen-controller.ts`: `stopTurn()` (P2) [H3].
7. `src/ui/HubFan.tsx` (new, render only: items, label, scrim, stagger);
   `src/ui/FloatingActivity.tsx` (S10's): feed the responder into
   `hub-gesture.reduce`, arm the 400 ms timer, render the ring/badge/glyph,
   `accessibilityActions` [H3].
8. `src/screens/SessionScreen.tsx`: the `entries` record (stop, steer →
   focus, activity, attach → the photo chooser extracted from `:647-653`
   into one `openAttach()` used by both the composer and the hub, info,
   sessions, new, dictate when `settings.dictation`); the `gestureEnabled`
   toggle; `ActionSheet` for More/VoiceOver; cancel on sheet/drawer open [H3].
9. `src/ui/Composer.tsx`: a `focusKey` (or ref) so Steer can focus the
   field [H3].
10. `e2e/flows/29-hub.yaml` (+ `29-hub.js` seeding a long mock turn and a
    background child); `e2e/flows/24-ui-shots.yaml` (hub idle + fan open,
    both themes) [H3].
11. Artifacts and Scheduled entries + badges in `SessionScreen.tsx` /
    `hub-actions.ts` contexts, each only once its task is on `main` [H4].
12. `changelog.d/mobile-hub.added.md` [H3]; this doc's Execution (every slice).

### Failure modes

| # | Case | How it converges |
|---|---|---|
| M1 | Transcript scroll vs the button | The button is a sibling overlay; its responder grants on touch-down and refuses termination. The scroll never sees the touch (load-bearing spike, H3 step 1). A scroll that starts elsewhere never reaches the button. |
| M2 | Back-swipe vs a left-edge button / an open fan | The button rests 10 pt inside (S10 F21), so the bezel swipe is the stack's. While the fan is open `gestureEnabled:false`, restored on every close path (commit, cancel, unmount). Flow 29 checks the back-swipe after a close. |
| M3 | Long-press then a tiny wobble | Travel is measured from the down point; < 10 pt before 400 ms is still a press. After the open, travel < 10 pt since the open → sticky (no accidental cancel). |
| M4 | Fast flick before 400 ms | Drag (reposition), never the fan, never a tap. |
| M5 | Keyboard up | Bounds are re-measured (S10). The button re-projects its yFraction. The fan solves in the smaller band, else the menu. The band < 108 pt → the button is hidden (F20). Opening the fan keeps the keyboard. |
| M6 | A sheet arrives mid-press (permission ask, outbox decision) | Visibility flips → `cancel` effect, `gestureEnabled` restored, no commit, no haptic; the sheet shows. |
| M7 | Turn ends while Stop is highlighted | `resolveCommit` re-reads: no turn → "Already finished", no-op. A foreign turn's Stop uses `foreign.cancel()` as today. |
| M8 | Link down | `stopTurn()` gets `none/turn` from `composerAction` (`composer.ts:82-84`). Stop is absent from the fan at open, and a commit that races a drop re-validates to a no-op with the notice. |
| M9 | Related task not merged / older daemon | Absent action (P6). Scheduled appears only when the daemon sends `schedules`; an older daemon never sends it. |
| M10 | VoiceOver toggled mid-fan | `AccessibilityInfo` change → `cancel`, then the VoiceOver rules. |
| M11 | Reduce Motion toggled live | `fanMotion` is read per open. |
| M12 | App backgrounded / call mid-press | The responder's terminate → `cancel` event; the timer is cleared on unmount and on every `up`/`cancel`. |
| M13 | The 400 ms timer fires after `up` | The reducer ignores a `timer` outside `pressing` (pinned test). |
| M14 | Too many items | > 6 → 5 + More; More = `ActionSheet` with the rest. |
| M15 | Rotation / Dynamic Type change while open | Layout change → `cancel` (the next open re-solves). |
| M16 | Two fingers | Only the first touch drives the machine; a second `down` while not `idle` is ignored. |
| M17 | Stop by mistake | Stop is red, labelled when highlighted and gated by release. It matches the composer's one-tap Stop (no confirm today), so the hub adds none. Noted as Q-H4. |

### Tests

Red first (AGENTS §9). Pure, bun test, `apps/mobile/test/`:

- `hub-gesture.test.ts`:
  - 9 pt / 390 ms → tap;
  - 10 pt at 100 ms → drag (no open even if held);
  - 400 ms still → `open` + `firm`;
  - slide across three items → three `highlight` + three `tick`, and a
    return to centre → `highlight(null)` with no tick;
  - release on an item → `commit(id)` + `commit` haptic;
  - release far away → cancel, no haptic;
  - release < 10 pt after the open → sticky, then `tapOverlay` on an item →
    commit, and `tapOverlay` elsewhere → close;
  - `timer` after `up` → nothing (M13);
  - second `down` ignored (M16);
  - `cancel` from every state restores idle.
  - **Mutation**: swap `<`/`≤` on `SLOP`, drop the sticky branch, fire the
    tick on null → tests fail.
- `hub-fan.test.ts`:
  - the sweep of the render-check as a property test (both edges ×
    yFraction 0…1 × n 1…6 × keyboard down/up × 390×844 and 375×667): every
    item inside bounds − padding, adjacent ≥ 56 pt, each ring in arc order
    from its lower end, item 0 on the inner ring (corrected in H1, see
    Design 3 "Order");
  - the one-ring case uses the minimum R;
  - the bottom-of-band case → two rings;
  - an impossible band (e.g. 120 pt high, n = 6) → `menu`;
  - `pickItem` hysteresis (no flip within 4° past the midpoint), dead zone,
    outer limit, ring choice by radius;
  - `labelPlacement` clamps on both edges.
  - **Mutation**: drop the padding, drop the two-ring step, invert the
    order → tests fail.
- `hub-actions.test.ts`:
  - idle → Attach, Activity, Sessions, Session info (+ More only past 6);
  - running → Stop, Steer first;
  - link down → no Stop;
  - a missing entry → absent (P6);
  - Dictate only with `settings.dictation`;
  - Scheduled only with schedules;
  - badge promotion never passes the turn pair;
  - 9 candidates → 5 + More + 4 in `more` in canonical order;
  - `resolveCommit(stop)` without a turn → `{notice:"Already finished"}`;
  - `buttonBadge` priority: number > dot > none;
  - `hubA11yLabel` wording.
- `haptic-rules.test.ts`: the hub effects map to `firm`/`tick`/`commit`/null.
- `floating-button.test.ts` (S10's, updated): `visible` shown at zero
  activity in Floating mode, hidden with a sheet/drawer/short band, never in
  Header mode; `isTap` updated to the new thresholds.
- `session-screen-controller` test: `stopTurn()` with a draft in the field
  still stops (own → abort spy; foreign → cancel spy), and with link down it
  does nothing. **Mutation**: call `act()` instead → the draft case fails
  (it would queue a steer).

Maestro `29-hub.yaml` (simulator, light and dark via `appearance.js`). The
press-slide-release path cannot be driven by Maestro: `swipe` starts moving
at once, which is a drag. So it is covered by the pure machine. The flow
covers:
1. Settings → Activity button → Floating; back in a session the hub is
   visible at zero activity.
2. `longPressOn: hub-button` (it releases in place) → sticky fan:
   `hub-item-attach` visible → tap → the photo chooser → Cancel.
3. Long-press → tap outside → the fan is gone.
4. The mock model starts a long turn → long-press → `hub-item-stop` is
   first → tap → the turn stops.
5. Tap the hub → Activity.
6. With the button on the left: long-press, close, then the back-swipe still
   works (M2).
7. Settings → Header → no hub.

VoiceOver and Reduce Motion are covered by the pure tests; Maestro cannot
toggle them reliably. This is stated here, not hidden.

### Slices

| # | Slice | Size · Blast · Model | Contents (Files) | Done when |
|---|---|---|---|---|
| H1 | **Gesture machine + fan geometry** | M · contained · `opus` (state machine + geometry, the tricky core) | 1, 2, 3 | `hub-gesture`/`hub-fan`/`floating-button` tests red→green + the three mutation checks |
| H2 | **Action list + haptic kinds** | S · contained · `deepseek` | 4, 5 | `hub-actions` + `haptic-rules` tests red→green + mutation |
| H3 | **Hub UI + wiring of what is on `main`** | M · contained (setting-gated) · `opus` | step 1 = the load-bearing spike; then 6–10, 12 | spike output pasted; controller test; flow 29 green in both themes; `bun run check` |
| H4 | **Artifacts + Scheduled entries** | S · contained · `deepseek` | 11, once feat/model-artifacts and feat/cron-tool S6 are on `main` (else the slice waits; the hub ships without them, P6) | `hub-actions` cases for both badges; flow 29 step: an unseen artifact → the dot + the item badge |

Then the Review: a fresh-context `/code-review` that red-teams M1–M17 and
§7 "logic lives in pure modules" (no threshold, hit-test or ordering in a
`.tsx`).

### Owner questions (each with the recommendation)

1. **Q-H1 · Default mode — FLAGGED.** Should "Floating (hub)" become the
   default instead of the header pill? *Recommendation: yes, flip it.* The
   hub now always shows, collects six surfaces in one reachable place and is
   the discoverable home for artifacts and schedules. Header mode gets none
   of it, and the reason it was off (it covers text) is softened: it is one
   54 pt circle on an edge, draggable. **Not done tonight**: the owner chose
   Header on 2026-11-15, so this plan implements Header as the default. The
   flip is a one-line default change in `activity-settings-store.ts` if
   approved.
2. **Q-H2 · Tap.** Keep tap = Activity (S10), or make tap open the fan in
   lift-then-tap mode (so tap and long-press both open the hub)?
   *Recommendation: keep tap = Activity.* It is a direct one-tap path to the
   most frequent target, S10 users keep their habit, and long-press gets a
   distinct meaning.
3. **Q-H3 · Thresholds and haptics.** 400 ms / 10 pt; open = medium
   impact, tick = selection, commit = rigid, cancel = silent.
   *Recommendation: as stated.* Fast enough not to feel sluggish, slow
   enough not to fire on a hesitant tap; three distinct textures.
4. **Q-H4 · Stop confirm.** Should Stop from the fan ask to confirm?
   *Recommendation: no.* It matches the composer's one-tap Stop, the
   release-gated selection with a red label is already deliberate, and a
   confirm would slow the one urgent action.
5. **Q-H5 · Order.** Running → Stop, Steer first; otherwise Attach,
   Activity, Artifacts, Sessions, Session info, (Scheduled, Dictate, New) →
   More past six, with badge promotion. *Recommendation: as stated.*
6. **Q-H6 · Header mode.** Give header mode a hub too (e.g. long-press on
   the pill)? *Recommendation: not in this task*; revisit if Q-H1 stays
   "Header".

#### Orchestrator decisions (owner delegated 2026-11-16)

- **Surface: the radial fan — owner's binding choice**; stack and sheet grid
  are kept in the mockups as alternatives.
- Q-H1: recommendation recorded, **FLAGGED for the morning — not applied**;
  Header stays the default as the owner chose on 2026-11-15.
- Q-H2: tap = Activity (adopted).
- Q-H3: 400 ms / 10 pt; medium / selection / rigid / silent (adopted).
- Q-H4: no confirm on Stop (adopted).
- Q-H5: the order and the six-slot rule as stated (adopted).
- Q-H6: no hub in header mode in this task (adopted).

## Execution

### H1 — gesture machine + fan geometry

*— claude-opus-5-5, 2026-11-16*

**Preconditions re-checked.** P1 holds: `git log main` has mobile-chrome merged
whole (`f0c80329`), and `apps/mobile/src/floating-button.ts` and
`ui/FloatingActivity.tsx` exist. This plan's load-bearing assumption (the
`PanResponder` keeps the touch off the button) is H3 step 1's on-device spike;
H1 is pure code and does not depend on it. H1's own load-bearing check is the
render-check, re-run before any edit: `bun .tentacle/tmp/mobile-hub/render-check.ts`
→ `[sweep] cases=1008 oneRing=944 twoRings=64 menuFallback=0 clipped=0`,
`RENDER-CHECK OK` (unchanged).

**As built, in order.**
1. Skeletons with the final signatures and placeholder bodies, then the tests.
   Red on assertions, not imports: `hub-gesture` + `hub-fan` 41 fail / 13 pass
   (the 13 are cases a no-op satisfies, e.g. "ignored in idle"; the mutations
   below cover them). `floating-button` (updated tests) 3 fail / 22 pass.
2. `apps/mobile/src/hub-gesture.ts`: `SLOP` 10, `LONG_MS` 400 (`:24-26`),
   `classifyPress` (`:31`), `reduce(state, event, solve)` (`:104`) with the
   states, events and effects of Design 1.
3. `apps/mobile/src/hub-fan.ts`: `fanLayout` (`:98`, a port of the mockup
   solver), `pickItem` (`:179`), `labelPlacement` (`:243`), `fanMotion`
   (`:286`); constants `:15-35`.
4. `apps/mobile/src/floating-button.ts`: `isTap` = `classifyPress(...) === "tap"`;
   `TAP_SLOP`/`TAP_MS` removed (no other users); `visible` = Floating ∧
   ¬covered ∧ fits.
5. Green: the three files, 82 pass / 0 fail.

**Drift from the Implementation (and why).**
- **Item order (plan corrected).** Design 3 and Tests said "item 0 has the
  largest y". The sweep proved that false in 34/1008 cases (all n = 6, high
  in the band: the arc passes straight down, so a middle item is lowest). The
  solver keeps the mockup's rule, "item 0 = the lower END of its ring, the
  rest in arc order". Sorting by y would scatter priorities along the arc.
  Design 3 "Order" and the Tests bullet are corrected; the property test
  checks arc adjacency, lower end first, item 0 on the inner ring.
- **Effects added**: `tap` (a tap needs an effect to open Activity) and
  `dragCancel` (a system cancel mid-drag puts the button back; S10's `back()`).
  `dragTo`/`drop` carry `delta` from the down point instead of a page point,
  because `FloatingActivity` positions from `start + delta`.
- **`reduce` takes `solve: () => HubMenu`** (layout + item ids). It is called
  only at the open, so the layout is the open-time snapshot (Design 5).
  `HubMenu.ids` is how `commit(id)` knows ids, because `fanLayout` takes only `n`.
- **Late timer**: an `up` at ≥ 400 ms that is still `pressing` (the JS timer
  was late) opens the fan *sticky* at the release point. Otherwise a held
  press would do nothing. A stale `timer` (< 400 ms after this press's `down`)
  is ignored. This extends M13.
- **Sticky + `down`**: a new touch on the button while sticky closes the fan
  (Design 1 "a tap … on the button closes"). Its release then meets `idle`.
- **Menu layout / no items**: `open(menu)` + `firm`, then the machine goes
  `idle` (the ActionSheet takes over). With zero ids nothing opens and there
  is no haptic.
- **Ring-boundary hysteresis, 4 pt** (`RING_HYSTERESIS`). It is not in the
  plan, but with two rings a finger at the boundary would flicker between
  rings, and every flicker is a haptic tick. The angular rule of the plan also
  holds at the arc's ends: the end item holds 4° past its own sector edge.
- **`labelPlacement`** takes the measured pill size and the screen rect, and
  returns the pill's top-left. The side gap is `LABEL_GAP` 40 pt from the item
  centre (the mockup's, it clears the ×1.3 item). Above = the pill's bottom
  40 pt above the centre. A pill wider than the screen starts at the left padding.
- **`visible` signature**: `count`/`unread` are dropped, so the one call site
  `screens/SessionScreen.tsx:524` loses those two lines. That file is H3's, but
  typecheck needs the change. **Interim effect on this branch until H3**: in
  Floating mode the S10 button shows at zero activity with an empty count.
- **Noted for H3, not changed**: Design 8 says the default rest is
  yFraction 0.72. S10's `place` defaults to 1 (bottom of the band), pinned by
  `floating-button.test.ts` "no stored position → … bottom". H3 decides.
- **Changelog**: `changelog.d/mobile-hub.added.md` was written now, with the
  plan's wording, as the orchestrator asked for one fragment. The plan gives
  it to H3. It describes the finished hub, and "Artifacts" depends on H4, so
  H3/H4 must re-check it before merge.

**Mutation checks** (`bun .tentacle/tmp/mobile-hub/mutate.ts`: apply one
mutation, run the narrow file, restore the bytes; tree re-verified green after):

```
M1 SLOP < → <= (classifyPress + far): 28 pass, 2 fail — e.g. classifyPress > exactly 10 pt → drag (the slop is exclusive)
M2 drop the sticky branch: 25 pass, 5 fail — e.g. long-press → fan > released < 10 pt after the open → sticky; no close, no haptic
M3 tick also on null: 23 pass, 7 fail — e.g. long-press → fan > slide across three items → three highlights + three ticks; back to centre → highlight(null), no tick
M4 drop the padding: 26 pass, 1 fail — e.g. fanLayout: the render-check sweep as a property > 1008 cases: inside the padding, ≥ 56 pt apart, arc order from the lower end
M5 drop the two-ring step: 22 pass, 2 fail — e.g. fanLayout: the render-check sweep as a property > never the menu on these phones, and the two-ring step is used
M6 invert the order: 25 pass, 2 fail — e.g. fanLayout: the render-check sweep as a property > 1008 cases: inside the padding, ≥ 56 pt apart, arc order from the lower end
M7 drop the hysteresis: 25 pass, 2 fail — e.g. pickItem: sectors, dead zone, reach, hysteresis > hysteresis: the neighbour wins only past the midpoint + 4°
M8 visible needs activity again: 24 pass, 1 fail — e.g. visible: the hub shows whenever Floating is on, unless covered or the band is short > Floating, uncovered, fits → shown, even with nothing running
```

M1–M6 are the plan's targets; M7–M8 were added.

**Gate.** `bun run typecheck` (root `tsc --noEmit` + `apps/mobile` +
`apps/relay`) clean · `bun run lint` clean (0 errors, 0 warnings; Biome
reformatted the new files once) · `bun test` 12695 pass, 5 skip, 0 fail
(the 5 skips are the opt-in docker ×2 / k8s ×2 / slow-socket ×1). No schema
was touched, so `protocol.json` was not regenerated and there is no
`protocol.d/` note.

**Status: H1 DONE.** H2–H4 not started.

### H2 — action list + haptic kinds

*— claude-opus-5-5, 2026-11-16*

**Load-bearing check (re-run before any edit).** H2 is pure, so it rests on
P2 and P3, not on the H3 spike. P2 holds: `composerAction` returns `stop`
only for a blank field, a running turn, a live link and a living session
(`composer.ts:75-103`), and `none/turn` on a dead link (`:82-84`). P3 holds:
`playHaptic` is the only `expo-haptics` caller and swallows failures
(`haptics.ts`). The kinds are one union (`haptic-rules.ts:8`). The installed
`expo-haptics` has `selectionAsync` and `ImpactFeedbackStyle.Rigid`
(`node_modules/expo-haptics/build/Haptics.d.ts:24`, `Haptics.types.d.ts:43`).

**As built, in order.**
1. Skeleton `src/hub-actions.ts` (final types, stub bodies) + `hubHaptic` stub,
   then the tests. Red on assertions: 20 fail / 8 pass. The 8 are the 4
   existing haptic tests plus 4 cases a stub happens to satisfy (e.g. "link
   down → no Stop"); mutations A3/A4/H2 below cover them.
2. `apps/mobile/src/haptic-rules.ts:13`: `HapticKind` gains `tick` and
   `commit`. `hubHaptic(effect)` (`:48`) = the effect's `cue` for `haptic`,
   null for every other effect. *When* to buzz stays decided by
   `hub-gesture.reduce` (H1); this only maps.
3. `apps/mobile/src/haptics.ts:16`: `play(kind)` is an exhaustive switch:
   `tick` → `selectionAsync()`, `commit` → `impactAsync(Rigid)`; `firm`/`light`/`success`
   are unchanged.
4. `apps/mobile/src/hub-actions.ts`: `HubEntryId`/`HubActionId`/`HubEntries`
   (`:12-27`); `hubActions` (`:148`): turn pair, then canonical, then a stable
   badge partition, then the six-slot cut; `resolveCommit` (`:177`);
   `buttonBadge` (`:196`); `hubA11yLabel` (`:207`). Stop/Steer presence goes
   through `composerAction({…, text: "", photos: 0})` (`turnStoppable`, `:104`),
   the same truth table as the composer (P2).
5. Green: 28 pass / 0 fail on the two files.

**Drift from the Implementation (and why).**
- **`resolveCommit(id, ctx, entries)`**: it takes `entries` as a third
  argument (the plan wrote `resolveCommit(id, ctxNow)`). A commit runs iff
  `hubActions` would still offer it now, so re-validation is the same rule as
  presence. It is not a second truth table, and it needs the entries for P6
  (an entry gone since the open becomes a silent no-op). `more` always runs.
- **The link-down notice.** M8 says a Stop that races a link drop is a "no-op
  with the notice", without saying which one. "Already finished" would be
  false there (the turn still runs daemon-side), so the notice is
  `NO_CONNECTION` = "Not connected — the turn keeps running". "Already
  finished" is used when the turn is gone or the session ended. Steer gets the
  same two notices as Stop.
- **Steer rides Stop's gate.** On a dead link, typing becomes Send later, not
  a steer (`composer.ts:85-87`). So the pair is offered only when
  `composerAction` resolves to `stop`, as the plan's "(turn !== null, link up)"
  reads.
- **Attach** is also gated on `ended === null`, besides `editable`
  (belt-and-braces for M7's "Attach on an ended session → no-op").
- **Badge promotion = a stable partition** of the canonical part: badged
  items first, in canonical order, then the rest. This is the literal "moves
  up to the first canonical slot that has no badge". Without badges nothing
  moves (pinned).
- **Item badges**: Artifacts = `{count: unseen}`; Scheduled = a dot when the
  next wake is ≤ 10 min away (`DUE_SOON_MS`). The context carries
  `schedules: number` + `nextWakeInMs: number | null`. H4 wires them from
  `schedules`. No other item has a badge (the button carries the activity
  count).
- **`hubA11yLabel`** adds "unread report" when that alone lights the dot, and
  uses the singular "1 new artifact". Otherwise it uses the plan's wording.
- **Not done here**: "More/menu choice → `light`" (Design 2) needs no rule
  function. H3 plays `light` directly. No `menuHaptic` was added.
- **Changelog**: the one fragment `changelog.d/mobile-hub.added.md` (written in
  H1) already covers the hub. H2 adds nothing user-visible on its own, so it
  is unchanged.

**Mutation checks** (`bun .tentacle/tmp/mobile-hub/mutate-h2.ts`: apply one,
run `hub-actions` + `haptic-rules`, restore the bytes; the tree was re-verified
green (28/0) after):

```
A1 promotion passes the turn pair: 27 pass, 1 fail — e.g. hubActions: badges and promotion > promotion never passes the turn pair
A2 six-cap off by one (<= → <): 27 pass, 1 fail — e.g. hubActions: six slots (M14) > exactly six: all in the fan, no More
A3 Stop ignores the link (no composerAction): 26 pass, 2 fail — e.g. hubActions: order and presence > link down (M8): no Stop, no Steer
A4 resolveCommit does not re-validate: 24 pass, 4 fail — e.g. resolveCommit: the world is read again at release (M7/M8) > Stop after the turn ended → no-op + Already finished
A5 badge priority swapped (dot > number): 27 pass, 1 fail — e.g. buttonBadge + hubA11yLabel > priority: a number (running) > a dot (unseen / unread) > none
A6 a missing entry still shows (P6): 23 pass, 5 fail — e.g. hubActions: order and presence > idle: the canonical order, no More while it fits in six
A7 no badge promotion: 26 pass, 2 fail — e.g. hubActions: badges and promotion > a badged item moves up to the first unbadged canonical slot, badged ones keep their order
H1 tick played as light: 27 pass, 1 fail — e.g. hubHaptic (docs/feat/mobile-hub.md Design 2) > the hub's cues: open = firm, a new highlight = tick, commit = commit
H2 every effect buzzes: 27 pass, 1 fail — e.g. hubHaptic (docs/feat/mobile-hub.md Design 2) > every other effect is silent (close, highlight, the commit itself, drag, tap)
```

The plan names no H2 mutation targets ("+ mutation"), so these nine were
chosen against the plan's test list.

**Gate.** `bun run typecheck` (root + `apps/mobile` + `apps/relay`) clean ·
`bun run lint` clean (0 errors, 0 warnings, after one Biome format of the new
test) · `bun test` 12719 pass, 5 skip, 0 fail (the 5 skips are the opt-in
docker/k8s/slow-socket ones). No schema was touched, so `protocol.json` was not
regenerated and there is no `protocol.d/` note.

**Status: H2 DONE.** H3–H4 not started. Nothing in the app calls
`hub-actions`/`hubHaptic` yet; H3 wires them.

## Review

*(empty — fresh-context review after H3/H4)*

#### Owner note (2026-11-16 ~10:20, binding)

*— recorded by claude-opus-5-5 (orchestrator), 2026-11-16*

"Fallo fare a Opus, che deve esser fatto bene, estetico, funzionale, di facile utilizzo e bello." **Every slice (H1–H4) is executed by Opus** (`slices.txt` updated), as is mobile-chrome S10 (the base floating button). The bar is visual and tactile quality, not only green tests: executors compare the result against the chosen fan mockup (A) frame by frame, tune springs/stagger/haptics for feel, and the Review judges aesthetics and ease of use as well as correctness.
