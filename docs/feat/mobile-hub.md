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
| H4a | **Scheduled entry only** (owner 2026-11-16: ship it now, cron-tool is on `main`) | S · contained · `deepseek` | the Scheduled-wakes half of H4: `hub-actions` case + badge (`schedules`, `nextWakeInMs`), Session info scrolled to SCHEDULED WAKES; tests incl. a real-screen render. The Artifacts entry stays for H4b, after feat/model-artifacts merges. | |

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

### H3 — hub UI + wiring (PARTIAL: blocked, out of disk)

*— claude-opus-5-5, 2026-11-16*

**Load-bearing check (step 1, the spike): NOT RUN, blocked by the environment.
It did not fail.** The spike was set up on the iOS 26 simulator (`iPhone 17 Pro`,
booted; Maestro present). It was a temporary edit of `ui/FloatingActivity.tsx`:
the button no longer follows the finger, and it records the number of moves, the
max page distance from the grant, release and terminate into a `spike-result`
text. A temporary flow 28 swiped from the button UP (over the transcript
`ScrollView`) and LEFT, with `duration: 1500`. It ran with
`bun run e2e:mobile --ios 26 --only 28-floating-activity`. The Release build
failed in `xcodebuild`:
`lipo: write() failed, errno=28 (No space left on device)` (run
`.tentacle/tmp/e2e-mobile/1794840387731/build-ios26.log`). `df`: 145 MiB free on
the data volume; `~/Library/Developer/Xcode/DerivedData` is 44 GB. Both spike
files were restored byte-for-byte from copies in `.tentacle/tmp/mobile-hub/spike/`
(`git status` showed them unmodified afterwards). To re-run it, use those copies
plus the flow described above. It needs ~10+ GB free (a full Fabric build).

**Done (it does not depend on the spike), red → green:**
1. `src/session-screen-controller.ts`: `stopTurn()` on the controller interface.
   `act()`'s stop branch is extracted into one `stop(action)`, which the
   composer's button and the hub both call (P2: not a second stop path).
   `stopTurn` = `stop(composerAction({link, text: "", turn, ended, photos: 0}))`.
   Tests in `test/session-screen.test.ts` › "stopTurn — the hub's Stop":
   - a foreign turn with a draft is cancelled (the composer shows `queue`, and
     the draft is kept);
   - an own turn with a draft aborts its signal;
   - link down → nothing is cancelled (M8);
   - with no turn, it is a no-op.
   Red on a no-op stub: 2 fail on assertions (`Expected: true / Received: false`);
   green 22/0.
2. `src/hub-session.ts` (new, pure; it is not in the Files list, see drift
   below) + `test/hub-session.test.ts`:
   - `hubContextOf`: the screen's facts; H4's fields are 0/null;
   - `solveHub`: the menu at the open, anchored on the button centre in band
     coordinates, with the stored edge; no band or a short band → menu;
   - `bandPoint`: the grant's local point on the button + the page delta, so no
     window measurement is needed;
   - `mustCancel`: the button hidden by a sheet or drawer (M6), VoiceOver on
     (M10), the band size changed (M15).
   Red on a valid stub: 7 fail / 2 pass; green 9/0.

**Mutations** (`bun .tentacle/tmp/mobile-hub/mutate-h3.ts`, which restores the
exact bytes; `git status` was clean of them afterwards):
```
S1 stopTurn calls act() (the plan's target): 20 pass, 2 fail — a draft in the field does not turn the hub's Stop into a steer
S2 stopTurn ignores the link:               21 pass, 1 fail — link down (M8): nothing is cancelled
S3 stopTurn reads the draft:                20 pass, 2 fail — a draft in the field …
W1 solveHub ignores the stored edge:         8 pass, 1 fail — a left-edge button fans to the right
W2 bandPoint drops the local point:          8 pass, 1 fail — the touch's spot on the button + …
W3 mustCancel ignores a band change:         8 pass, 1 fail — the band changed (M15)
W4 mustCancel ignores the sheet/drawer:      8 pass, 1 fail — a sheet or the drawer hides the button (M6)
```

**Not done (waiting on the spike + disk):** `ui/HubFan.tsx`, the
`FloatingActivity` rewrite (responder → `reduce`, the 400 ms timer, the glyph,
the arc and badge, `accessibilityActions`), the `SessionScreen` entries,
`openAttach`, `gestureEnabled`, More/VoiceOver `ActionSheet`, Composer focus for
Steer, flow 29 + shots, and the changelog re-check. The fragment
`changelog.d/mobile-hub.added.md` is H1's and is unchanged.

**Drift / decisions so far.**
- New pure module `hub-session.ts`. It keeps the glue that branches and
  computes out of the `.tsx` files (AGENTS §7): the open-time solve, the
  coordinate mapping, and the cancel rule.
- Planned for the UI, not built: the scrim covers the band only (RN iOS does not
  hit-test outside a parent's bounds), so the header and composer stay live
  under a sticky fan. "New session" needs `SessionDrawerHost`'s render prop in
  `App.tsx` to pass `fresh.start` down (`App.tsx:1024`, `:1202`). That file is
  not in the plan's Files list.

**Gate (partial state).** `bunx tsc --noEmit` and `-p apps/mobile` / `-p apps/relay`
are clean. `bun run lint` is clean (1748 files) after `biome check --write` on the
new test. `bun test` (full): **505 fail, not attributable**. It ran with the disk
full: the run ended with `no space left on device`, and afterwards no command
could start (ENOSPC on the tool's temp dir). The narrow files passed before the
disk filled: `session-screen` 22/0, `hub-session` 9/0. Re-run `bun test` once
space is freed.

**Status: H3 PARTIAL** (controller `stopTurn` + the pure wiring seam done; the
spike and all UI blocked by a full disk). H4 not started.

### H4a — Scheduled entry only

*— claude-opus-5-5, 2026-11-16*

**Load-bearing check (run FIRST, passed).**
`.tentacle/tmp/mobile-hub/h4a/repro.ts`. Two facts the slice stands on, both
verified before any code:

- **L1 — cron-tool S6 IS on `main`.** `git merge-base --is-ancestor 57a6dc91 main`
  holds, and the rows reach the phone: `RemoteSession.schedules`/`onSchedules`
  (`@tentacle/client`), gated by the client's `daemonWakes` trust bit (AGENTS §7:
  a pod's table is dropped there). So no protocol work, no new seam.
- **L2 — the table is enough.** `schedules` is its length and `nextWakeInMs` the
  distance to the soonest `nextAt`; nothing else on the wire is needed.

The CAPABILITY was missing, which is what the slice exists to add. Output
(before):

```
hubContextOf → {"schedules":0,"nextWakeInMs":null}
ids with a `scheduled` entry wired: ["attach","activity","sessions","info"]
Session info sections: ["model","session","schedules","mcp","skills"]
rows exist but there is no reveal API: undefined
```

`hubContextOf` hard-coded `schedules: 0, nextWakeInMs: null`, so
`hub-actions`' `holds("scheduled")` was never true and the item could not appear
(not a bug — P6's rule — but a missing input). And Session info had no way to be
opened AT a band, so even a wired item could only have opened the sheet at the
top, four screens above the wakes.

**Done, in order, red → green.**
1. `src/hub-session.ts`: new pure `wakeContext(rows, now) → {schedules,
   nextWakeInMs}` — the count is the table's length, the delay is measured to the
   SOONEST `nextAt` (the daemon's order is not the firing order), clamped with
   `Math.max(0, …)` so an already-due wake reads `0` rather than a negative
   "in −40 s", and empty/`undefined` → `0`/`null` (an older daemon, M9).
   `hubContextOf` takes an optional `schedules: {rows, now}` and fills the two
   fields from it. `test/hub-session.test.ts`: 13 pass.
2. `src/session-info.ts`: new pure `scheduledSection(view | null) → "schedules" |
   null` — the band only when the sheet actually DRAWS it, so a reveal is never a
   scroll to empty air. Plus the reveal rule: `revealStart`, `revealStep`,
   `REVEAL_IDLE`, `RevealState`, and a module-private `revealOffset`. It scrolls
   ONCE (reaching the wanted band spends the want, so later layouts never
   re-scroll under the person's own scrolling), only when the WANTED band
   reports (the bands lay out in any order), and a measured `y = 0` is a real
   offset, not "unmeasured". `test/session-info-reveal.test.ts` (new): 7 pass.
3. `src/screens/SessionInfoSheet.tsx`: stays HOOK-FREE — the real-element walker
   in `test/band-notes.test.ts` calls it directly, and hooks broke it, which is
   why the reveal lives in the parent. Two new optional props: `scrollRef` (a
   callback ref onto the `ScrollView`) and `onSectionLayout(id, y)` (an
   `onLayout` on each section's own `<View>`).
4. `src/screens/SessionScreen.tsx`: ONE `openInfo(revealTo)` path — the header
   ring, the "…" menu and `openScheduled()` all come through it, so a reveal is
   never a second way into the sheet; `revealOnLayout` calls `revealStep` and
   scrolls `infoScroller`. The menu is built with
   `sessionMenu(rows, state.schedules?.length ?? 0)` and handles the new
   `"scheduled"` action by calling `openScheduled()`; its "Nothing to copy yet"
   footnote now keys on `action.text === ""` (a reveal action copies nothing).
5. `src/session-menu.ts`: `sessionMenu(rows, wakes = 0)` adds
   `{id: "scheduled", label: "Scheduled wakes", text: ""}` right after Session
   info when `wakes > 0`. `test/session-menu.test.ts` +2 tests.
6. `src/session-screen-controller.ts`: `WakeHandle`
   (`Partial<Pick<RemoteSession, "schedules" | "onSchedules">>`) → `SendableHandle`
   extends it; `SessionScreenState.schedules`; `watchActivity` also subscribes
   `onSchedules`, cleared on leave, `emit()`ing each report.
   `test/session-screen-wakes.test.ts` (new): 5 tests.
7. `test/session-info-schedules-render.test.ts` (new: the slice's required
   "real-screen render"): the sheet's REAL element tree, walked the way
   `band-notes.test.ts` does (one function stub call per element, host stubs as
   string types). It asserts the band's rows are host nodes with
   `session-info-schedules-<key>` and `…-delete`, that the delete sends the RAW
   id (a fixture whose id is longer than `scheduleIdLabel`'s 24-char bound, so the
   row KEY and the wire id differ — an earlier fixture of mine had them equal and
   the mutation survived), that no switch is drawn, that an older daemon's
   `rows: undefined` is the `unsupported` empty row, and that
   `onSectionLayout`/`scrollRef` reach the sheet and report each band's own y.
8. `test/hub-scheduled-wiring.test.ts` (new): the source-reading guard for
   `.tsx` (the `schedule-wiring.test.ts` pattern), because `SessionScreen.tsx`
   cannot run under `bun test`. It pins the two seams, that the band id is typed
   `SectionId`, that `openScheduled` goes through `openInfo`, that exactly ONE
   place sets `infoOpen`, and that the menu's `scheduled` action calls
   `openScheduled` and the menu is built with the wake count.
9. `test/header-wiring.test.ts`: F11's guard asserted the ring's `onPress`
   contains a literal `setInfoOpen(true)`. Step 4 moved that into `openInfo`, so
   the guard went RED (`Found: "onPress={() => openInfo()}"`), and it was
   re-pinned to the new truth (`onPress={() => openInfo()}` AND `openInfo` still
   being what sets `infoOpen`) — the same invariant, one seam further out.

**Mutations — 14/14 killed**, by `.tentacle/tmp/mobile-hub/h4a/mutate.ts`
(applies one mutation to the source, runs the files, restores the exact bytes;
the last line is `restored (unmutated): 33 pass, 0 fail`):
```
M1 the wake feed is never followed (onSchedules unused): 29 pass, 4 fail
M2 the report is applied without telling the screen (no emit): 32 pass, 1 fail
M3 an empty REPORTED table reads as 'no feed' (undefined): 32 pass, 1 fail
M4 the wake feed is never unsubscribed on leave: 32 pass, 1 fail
W1 wakeContext counts rows but takes the FIRST wake, not the soonest: 32 pass, 1 fail
W2 an already-due wake reads a negative delay: 32 pass, 1 fail
W3 an empty table still reports one wake: 32 pass, 1 fail
W4 hubContextOf ignores the wake feed: 32 pass, 1 fail
S1 scheduledSection scrolls even when the sheet draws no such band: 32 pass, 1 fail
S2 revealStep re-scrolls on every layout (the want is never spent): 32 pass, 1 fail
S3 revealStep treats a measured 0 as "unmeasured": 32 pass, 1 fail
S4 revealStep scrolls before the wanted band reports: 29 pass, 4 fail
N1 the menu offers Scheduled with no wakes armed (P6/M9): 29 pass, 4 fail
N2 the Scheduled action carries text (it would copy, not reveal): 32 pass, 1 fail
```
Two of them (`W1`, `S1`) first reported `TARGET NOT FOUND` because
`biome check --write` had re-wrapped the very expressions they patched; both were
re-pinned to the formatted text and re-run, and each then killed its test.

Red before green, the render and the wiring guard specifically:
- `session-info-schedules-render` — `onSectionLayout(section.id, 0)` (report a
  constant instead of the measured y): 5 pass, 1 fail, `"y": 400 → "y": 0`.
- `hub-scheduled-wiring` — with `onSectionLayout={revealOnLayout}` deleted:
  5 pass, 1 fail (`Expected to contain: "onSectionLayout={revealOnLayout}"`);
  with `openInfo(scheduledSection(...))` → `openInfo(null)`: 4 pass, 2 fail; with
  the menu's `openScheduled()` call deleted: 5 pass, 1 fail.

**Changelog.** A NEW fragment `changelog.d/mobile-hub-scheduled.added.md`.
H1's `changelog.d/mobile-hub.added.md` describes the fan, which H3 has not
shipped, so folding a shipped fact into it would be the dishonest shape; a
separate bullet names only what a person can see today. `CHANGELOG.md` untouched.

**Drift from the Implementation.**
1. **The reveal lives in `SessionScreen`, not the sheet**, and rides a callback
   ref + `onSectionLayout` rather than any sheet-side state. The sheet must stay
   hook-free: `test/band-notes.test.ts` calls `SessionInfoSheet` as a plain
   function and walks the returned elements, and a `useState`/`useRef` there
   throws outside a renderer (it broke that file). This is the honest reading of
   §7 anyway — the rule is pure (`revealStep`), the component only reports y and
   the screen only scrolls.
2. **The "…" menu gains "Scheduled wakes"** as the reachable trigger for the
   reveal. H4's trigger is the hub's fan item, and H3's fan UI is not on this
   branch, so without the menu the reveal would be unreachable code and the slice
   could not be demonstrated at all. It is also the right place on its own: the
   sheet is the only screen that can read and delete a wake. The menu entry
   disappears when no wakes are armed (P6/M9), exactly as the fan item does.
3. **New pure rules not in the Files list** (`wakeContext`, `scheduledSection`,
   `revealStart`/`revealStep`/`REVEAL_IDLE`/`RevealState`): item 11 names
   `SessionScreen.tsx`/`hub-actions.ts` only, but AGENTS §7 puts every branch
   that matters in a pure, React-free, unit-tested module. The alternative was
   arithmetic and a scroll rule buried in a `.tsx` the harness cannot execute.
4. **No separate `session.schedules` read.** The controller subscribes
   `onSchedules` and the seam hands the known table at once, so a redundant
   `session.schedules` read was removed during the work (it was in the first
   draft).
5. **`header-wiring.test.ts` was edited** (F11's guard): unavoidable collateral
   of the one-path refactor, and re-pinned rather than loosened (it now asserts
   `openInfo()` calls the setter, so a second way in still fails).

**Gate.** `bunx tsc --noEmit`, `bunx tsc -p apps/mobile --noEmit` and
`bunx tsc -p apps/relay --noEmit`: clean. `bun run lint`: clean (1782 files,
`biome check --write` applied to the H4a files). `bun test` (full): **12983 pass,
5 skip, 0 fail** (12988 tests / 925 files) — the 5 skips are the pre-existing
opt-in set (`main` runs 12953 pass / 5 skip / 0 fail), and the +30 passes are
H4a's. Two runs were lost first, both to the environment, not the code: the disk
was momentarily 100 % full (`buildBinary` failed with
`failed to write compiled executable tentacle` / `Error writing standalone module
graph: Io`, and both tests pass once space returned), and the worktree was
missing `packages/tools/node_modules/pdfjs-dist` until `bun install --frozen-lockfile`
(one root-tsc error, gone after). No protocol schema was touched, so
`packages/protocol/schema/protocol.json` is NOT regenerated — `git status`
confirms it does not appear.

**Status: H4a DONE.** H3 remains PARTIAL (its fan UI is still unbuilt and
disk-blocked), so **the hub's own Scheduled fan item is not reachable yet**: the
moment H3's `entries` record lands with `scheduled` → `openScheduled()`, the item
appears, badged, with nothing else to write — `hub-actions` already gates and
badges it, `wakeContext` already fills its context, and `openScheduled` is
already the one path to the revealed sheet. H4b (the Artifacts entry) is not
started: `feat/model-artifacts` is not on `main`.

### H4b — Artifacts entry

*— claude-opus-5-5, 2026-11-17*

**Load-bearing check (run FIRST, passed).** feat/model-artifacts IS on `main`:
`main` = `HEAD` = `10838ee4 Merge branch 'feat/model-artifacts'`, and its doc
hands the hub exactly two things (`model-artifacts.md:439,443-449`):
`unseenArtifacts(list, seen)` (`artifact-gallery.ts:99`, "the count the hub
badges") and the ONE entry `openArtifactGallery(nav, {…, from})`
(`routes.ts:88`), whose `from` union already includes `"hub"` (`routes.ts:67`).
The capability was missing: `hubContextOf` hard-coded `unseenArtifacts: 0`
(`hub-session.ts:75` before), and the screen's opener was typed
`(from: "session-info" | "card")` (`SessionScreen.tsx:130`, `App.tsx:1285`), so
no caller could open the gallery `from: "hub"`. No protocol work, no new seam.

**Done, in order, red → green.**
1. `test/hub-session.test.ts` +5 tests (the H4b describe): no feed / an empty
   list → 0 and the item unbadged; the count is ARTIFACTS with something new,
   not versions; the seen record is honoured (gallery opened → 0, a new version
   → 1, the version itself opened → 0); three unseen → the item first with
   `{count: 3}` and the button's dot (flow 29's step, as a pure test); no
   `artifacts` entry → no item (P6). RED first: 16 pass, 3 fail (the count
   stayed 0).
2. `src/hub-session.ts`: `hubContextOf` takes an optional
   `artifacts: {list, seen}` and fills `unseenArtifacts` with the gallery's OWN
   `unseenArtifacts` — never a second rule, so the hub, the Session-info row and
   the gallery cannot disagree on "new". `undefined` list → 0. Green: 19/0.
3. `test/hub-artifacts-wiring.test.ts` (new): `openArtifactGallery` carries
   `from: "hub"` unchanged; both hand-offs (`SessionScreen.tsx`, `App.tsx`) type
   the origin as `ArtifactGalleryRoute["from"]`, not a copied union; and a
   compile-time assignment (`tsc -p apps/mobile` includes tests) that fails while
   the screen's prop is narrower than the route's union. RED first: 1 pass,
   1 fail + `TS2322 '"hub"' is not assignable to '"session-info" | "card"'`.
4. `src/screens/SessionScreen.tsx:132` and `App.tsx:1286`: `onOpenArtifacts`
   typed `(from: ArtifactGalleryRoute["from"]) => void`. Green: 2/0, tsc clean.
5. `changelog.d/mobile-hub.added.md`: one clause ("Artifacts carries the count of
   new artifacts and opens the gallery") in H1's hub fragment, which already
   names the Artifacts item. No new fragment: nothing is visible until H3's fan
   ships, so a separate bullet would announce an unreachable feature.

**Mutations — 5/5 killed** (`.tentacle/tmp/mobile-hub/h4b/mutate.ts`: apply one,
run the two H4b files (+ `tsc -p apps/mobile` for type ones), restore the bytes):
```
B1 hubContextOf ignores the artifacts feed (always 0): 18 pass, 3 fail
B2 the badge counts VERSIONS, not artifacts: 20 pass, 1 fail
B3 the device's seen record is ignored: 20 pass, 1 fail
B4 the screen's opener narrowed back to the pre-H4b union: 20 pass, 1 fail · tsc -p apps/mobile: 1 error(s)
B5 App's hand-off typed as a COPIED literal union: 20 pass, 1 fail · tsc -p apps/mobile: 0 error(s)
restored (unmutated): 21 pass, 0 fail
```

**Drift from the Implementation.**
1. **No `entries.artifacts` and no live context in `SessionScreen`.** Item 11
   puts the entry "in `SessionScreen.tsx`", but H3 is PARTIAL: there is no
   `entries` record and no `hubContextOf` call in the screen to add it to (rg:
   `hubContextOf` has no caller in `src/`). Adding an unused callback would be
   dead code. H3's hand-off, all already typed and tested:
   - entry: `artifacts: onOpenArtifacts === undefined ? undefined : () => onOpenArtifacts("hub")`
     (absent without a router: P6);
   - context: `hubContextOf({…, artifacts: {list: state.artifacts.list, seen}})`,
     with `seen = seenFor(ARTIFACT_SEEN.current(), sessionKey(computerId, sessionId))`
     (`artifact-seen-store.ts:58,63`, `artifact-seen-expo.ts:71`). The screen has
     no `computerId`/`sessionId` props today, so H3 passes a `() => ArtifactSeen`
     reader from the session route in `App.tsx` (which has both);
   - the button: `buttonBadge`/`hubA11yLabel` take the same `ctx.unseenArtifacts`.
2. **No "…" menu trigger** (unlike H4a's Scheduled wakes): Session info's own
   Artifacts row and a transcript card are model-artifacts' triggers already.

**Found, not fixed (outside H4b; model-artifacts' wiring).** In the real app,
Session info's Artifacts row is never drawn: `infoWiring` (`App.tsx:446-519`)
offers neither `artifacts()` nor `artifactSeen()`, and the controller draws the
section only when `port.artifacts` exists (`session-info-controller.ts:316-325,
427-430`). So today the gallery is reachable only from a transcript card. Verify:
`rg -n "artifactSeen|artifacts:" apps/mobile/App.tsx`. A fix task should wire both
(the seen reader is the same one H3 needs above).

**Gate.** `bunx tsc --noEmit`, `bunx tsc -p apps/mobile`, `bunx tsc -p apps/relay
--noEmit`: clean (apps/mobile first showed 6 errors for missing
`expo-document-picker`/`react-native-webview`/`react-native-svg` in this worktree;
gone after `bun install --frozen-lockfile`, no lockfile change). `bun run lint`:
clean (1929 files). `bun test` (full): **13966 pass, 5 skip, 0 fail** (13971 tests
/ 999 files; the 5 skips are the opt-in set). No schema touched:
`protocol.json` not regenerated, no `protocol.d/` note.

**Status: H4b DONE** (as far as H3's absence allows: the context and the entry's
origin are wired and tested; the fan item appears the moment H3 adds the two lines
above).

## Review

*(empty — fresh-context review after H3/H4)*

### Review — H4b (Artifacts entry)

*— claude-opus-5-5, 2026-11-17* (fresh context; same model family as the section's signer — shared blind spots possible)

**Verdict: APPROVE-WITH-NITS.** No HIGH/MEDIUM finding.

- Gate: `bun test` H4b files 21 pass / 0 fail; `bun run lint` clean (1929 files); `bun run typecheck` (root + mobile + relay) clean.
- Premises TRUE: `unseenArtifacts` (`artifact-gallery.ts:99`) counts artifact ids, not versions, `>=` lastGalleryAt + opened sha; `routes.ts` `from` union includes `"hub"`; `hubContextOf` has no `src/` caller (H3 unbuilt), so the drift note (no `entries.artifacts`) is accurate.
- Mutation (mine): `unseenArtifacts(...)` → `list.length` in `hub-session.ts:88` ⇒ 17 pass / 2 fail; reverted, `git status` clean. Executor's B1–B5 table consistent.
- §7: pure-module rule held (count lives in `hub-session.ts`, reuses the gallery's rule — no second definition of "new"); no protocol/persistence/broker/terminal path touched; P6 (no entry ⇒ no item) tested.
- Nits: (1) `changelog.d/mobile-hub.added.md` now announces "Artifacts carries the count…" though the fan item is unreachable until H3 — contradicts Execution's own reason for not adding a bullet; acceptable only because the whole fragment already assumes H3 ships before release. (2) the source-regex test in `hub-artifacts-wiring.test.ts` is brittle to formatting; the tsc assignment is the real guard. (3) attribution: HEAD commit says `exec (deepseek)`, the H4b section is signed `claude-opus-5-5` — reconcile which model executed.
- Attacks tried: count-versions mutation (killed); `undefined` vs `[]` feed (both 0, tested); seen record after gallery open + new version (re-badges, tested); type narrowing of the opener (tsc-pinned).

#### Owner note (2026-11-16 ~10:20, binding)

*— recorded by claude-opus-5-5 (orchestrator), 2026-11-16*

"Fallo fare a Opus, che deve esser fatto bene, estetico, funzionale, di facile utilizzo e bello." **Every slice (H1–H4) is executed by Opus** (`slices.txt` updated), as is mobile-chrome S10 (the base floating button). The bar is visual and tactile quality, not only green tests: executors compare the result against the chosen fan mockup (A) frame by frame, tune springs/stagger/haptics for feel, and the Review judges aesthetics and ease of use as well as correctness.

### H1 + H2 — fresh-context adversarial review

*— claude-opus-5-5, 2026-11-16* (same model as the executor, fresh context only: blind spots we share can survive both passes)

**Verdict: REQUEST-CHANGES** (1 MEDIUM; the rest holds).

1. **MEDIUM — Stop/Steer re-validation does not check that it is the same turn** (`apps/mobile/src/hub-actions.ts:177-186`).
   `resolveCommit` asks "does *a* stoppable turn exist now", not "is the turn shown at the open still the one running".
   Scenario: turn A runs, the user long-presses and highlights Stop, A ends, and turn B starts before the release (an outbox send-later flush, another device's prompt, or a queued follow-up). `resolveCommit("stop", ctxNow)` returns `run`, so H3's `stopTurn()` cancels B, a turn the user never saw start.
   This breaks M7's convergence ("the turn has already ended → no-op + Already finished"). Fix: snapshot `turn.turnId` at the open (in `HubMenu` or as a `resolveCommit` argument) and return `noop{ALREADY_FINISHED}` when `ctxNow.turn?.turnId` differs. Add a red→green test for it.

**Gate (re-run here).** The five touched test files pass, 110/0 · `bun run lint` is clean (1746 files, no fixes) · `bun run typecheck` is clean (root + mobile + relay). The full `bun test` was not re-run (the scope is the pure slices).

**Mutations (reviewer's own, `.tentacle/tmp/mobile-hub/rev/mut.ts`; bytes restored, `git status` clean afterwards).** Each of these makes a test fail: a second `down` restarts the press (M16) · a stale timer accepted (M13) · sticky ignores `down` · drag cancel without `dragCancel` · a late-timer `up` becomes a tap · the notice ignores `ended` · the sticky hit radius +20 · no ring hysteresis. **One survives:** Attach without the `ended === null` guard (22/0). That is a nit: the guard is belt-and-braces, and no test pins it.

**Attacks that found nothing.**
- Timer after `up` / timer of an earlier press: ignored.
- Wobble < SLOP then return: sticky.
- Ring-boundary flicker: 4 pt band.
- End-of-arc hysteresis is consistent with "midpoint + 4°" (`heldOff − bestOff < 2·hyst`).
- `ids`/`items` length mismatch: `commit` → `CLOSE`.
- Zero ids: no open, no haptic.
- Import cycle `floating-button → hub-gesture → hub-fan → floating-button`: type-only, so it is erased.
- §7 "logic in pure modules": all thresholds, hit-tests and ordering are in `.ts`, no React.
- No protocol, persistence or daemon surface is touched.

**Noted, not a finding.**
- Until H3, Floating mode shows the S10 button at zero activity (`SessionScreen.tsx:524`). This is documented and the setting is off by default.

**Executor behaviour.** The executor worked red-first. Drifts were recorded honestly (the item-order correction was backed by the sweep). Mutation logs were reproduced in kind.

### Fix round 1

*— claude-opus-5-5, 2026-11-16*

**Findings addressed:** Review round 1's one MEDIUM (HIGH: none). Plus the
Review's surviving mutation (Attach's `ended === null` guard, listed there as a
nit: no test pinned it) and a mutation of my own that survived first.

1. **MEDIUM — Stop/Steer re-validation must check it is the same turn.** FIXED.
   `resolveCommit` now takes the open's snapshot as a fourth argument,
   `HubOpen{ turnId: string | null }` (`apps/mobile/src/hub-actions.ts:176-185`),
   built at the open by a new `hubOpen(ctx)` (`:182`) — the same shape as the
   layout snapshot the fan already carries. `sameTurn(id, ctx, open)` (`:187`)
   gates Stop/Steer on `ctx.turn?.turnId === open.turnId`; the notice is
   `ALREADY_FINISHED` when the shown turn is gone, ended, **or replaced**, and
   `NO_CONNECTION` only for a failure on the *same* turn (`:208-218`). So turn A
   ending and turn B starting during the press is a no-op with "Already
   finished" — B is never cancelled from a fan that never showed it. Same for
   Steer (focusing the composer for a turn the person did not see). The three
   pre-existing `resolveCommit` cases were updated to pass the argument; no
   behaviour of theirs changed.
2. **Review's surviving mutation — Attach.** FIXED (test only): a second
   `resolveCommit("attach")` case keeps `editable: true` and `ended: "closed"`,
   so the `ended === null` guard is now pinned. Removing the guard fails 1 test.
3. **My own surviving mutation (`hubOpen` returning `null`).** Found by running
   the mutations below: the snapshot builder H3 calls was unpinned, and a
   `null` snapshot would make Stop never run. Added a test that asserts
   `hubOpen` both directions and drives `resolveCommit` end to end with it.

**Red before green.** The new cases fail on the unfixed source on the assertion
of the property, not on a compile error — the fourth argument was optional-free,
so adding it to the test file was the only change needed to see red:

```
bun test apps/mobile/test/hub-actions.test.ts   (fix NOT applied)
(fail) … > a DIFFERENT turn since the open → Already finished, never that new turn (M7)
       - { "kind": "noop", "notice": "Already finished" }  + { "kind": "run", "id": "stop" }
(fail) … > idle at the open: a turn that started since is not stoppable from that fan
       - { "kind": "noop", … }  + { "kind": "run", "id": "stop" }
 22 pass · 2 fail
```

Green after the fix: `hub-actions` + `hub-gesture` 54 pass / 0 fail; after
adding the `hubOpen` case, `hub-actions` 25 pass / 0 fail.

**Mutation checks** (`.tentacle/tmp/mobile-hub/fix1-mut.ts`: apply one, run
`hub-actions.test.ts`, restore the exact bytes — the tree was re-verified 25/0
after, `git status` shows only the two intended files):

```
F1 sameTurn dropped (any running turn stoppable):                22 pass · 3 fail
F2 sameTurn covers Stop only (Steer unchecked):                  24 pass · 1 fail
F3 stale turn's notice = NO_CONNECTION (identity not in `over`): 22 pass · 3 fail
F4 hubOpen always returns {turnId: null}:                        24 pass · 1 fail  (after finding 3)
F5 Attach's ended===null guard removed (the Review's survivor):  24 pass · 1 fail
restored (unmutated):                                            25 pass · 0 fail
```

F4 survived the first run (24/0) — that is what produced finding 3; each
mutation is killed by a test that names its property (`a DIFFERENT turn since
the open`, `idle at the open`, `Attach on an ended session`, `hubOpen takes the
turn's identity`).

**Gate.** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit` clean ·
`bunx tsc -p apps/relay --noEmit` clean · `bun run lint` clean (1746 files, no
fixes) · `bun test` 12722 pass, 5 skip, 0 fail (12727 across 907 files; the 5
skips are the opt-in docker/k8s/slow-socket ones). No protocol schema, no
persistence, no daemon surface touched; the changelog fragment is unchanged
(this round only makes an unreleased, unwired pure module correct — H3 still
does the wiring, so nothing user-visible ships from it).

**Note for H3.** The wiring must call `hubOpen(ctx)` when the `open` effect
fires and pass that value to `resolveCommit` on `commit` — the snapshot is the
fan's, not the release's. It is the same point where `hubActions` is already
evaluated (the `solve` callback of `reduce` returns the `HubMenu`), so H3 can
take both from one read, or widen `HubMenu` to carry the `HubOpen`; I left
`HubMenu` alone (it is a gesture-machine type, and `HubMenu.ids` already
mirrors the actions) rather than change `hub-gesture.ts` for a field nothing
reads yet.

### Round 2

*— claude-opus-5-5, 2026-11-16* (same model as round 1, fresh context only)

**Verdict: PASS.**

**Round-1 MEDIUM is fixed** (`apps/mobile/src/hub-actions.ts:171-218`, commit `8dccb2ac`). A Stop or Steer now runs only if the turn running at the release is the turn shown when the fan opened. `hubOpen` takes that turn's `turnId` at the open, and `sameTurn` compares it at the release. A replaced turn gives no-op + `ALREADY_FINISHED`. `TurnRow.turnId` is a non-null `string` (`transcript-rows.ts:118`), so the `?? null` cannot make two different turns compare equal.

**Mutations** (`.tentacle/tmp/mobile-hub/rev/mut2.ts`; bytes restored, `git status` clean). Each of these makes a test fail:
- drop `sameTurn`: 3 fail
- the notice ignores the turn change: 3 fail
- `hubOpen` always null: 1 fail
- `sameTurn` skips Steer: 1 fail
- Attach without its `ended` guard: 1 fail (the nit that survived round 1 is now pinned)

**Regressions.** `bun test apps/mobile/test/`: 2216 pass, 0 fail. `bun run lint` is clean (1746 files). `bun run typecheck` is clean (root + mobile + relay).

**Caveat for H3.** The new `resolveCommit` argument does nothing unless H3 takes `hubOpen(ctx)` exactly when `open` fires and passes it at the release. H3's review should check that wiring.

## Review

*— claude-opus-5-5, 2026-11-16* (H3 partial, commit `f317a593`. Same model family as the doc's executor signature, fresh context only.)

**Verdict: PASS for the code delivered. No HIGH or MEDIUM findings.** H3 is still **PARTIAL**: the spike, the UI, flow 29 and the full gate are not done, so it is not mergeable as a slice.

**Premises.**
- TRUE: `stop()` is the one stop path. `act()` falls through to it (`session-screen-controller.ts:1024`), and so does `stopTurn` (`:1041`), so P2 holds.
- TRUE: `stopTurn` reads the same `link`/`turn`/`closed` inputs that `sessionView` gives `composerOf` (`session-view.ts:358`). It passes `text: ""` and `photos: 0`, so a draft or a photo cannot turn Stop into a queue or into `none`.

**Gate.**
- `session-screen` + `hub-session`: 31 pass, 0 fail.
- `bun run lint`: clean (1748 files).
- `bun run typecheck`: clean (root, mobile and relay).
- Full `bun test`: NOT re-run. The data volume still has only 146 MiB free.

**Mutations** (`.tentacle/tmp/mobile-hub/rev3-mut.ts`; bytes restored, `git status` clean).
- These make a test fail: drop the own abort (2 fail); drop the foreign cancel (2); remove the voiceOver cancel clause (1); default edge `left` (1); a short band no longer gives the menu (1).
- **These survive (nits, not findings):**
  - `stopTurn` passing `ended: null` instead of `transcript.closed`: 22/0. The ended guard of the hub's Stop is unpinned.
  - `hubContextOf` hard-coding `dictation: false`: 9/0.

**Attacks that found nothing.**
- A draft or photos during a hub Stop: decided as blank, so Stop still runs.
- Link down: `none`, so nothing is cancelled (M8, pinned).
- Re-entrancy: `stop` is synchronous and does not touch `draft`, so `press`'s `sends` count is not affected.
- §7 "logic in pure modules": `hub-session.ts` imports no React.
- No protocol, persistence or daemon surface is touched.

**Carried to the rest of H3.**
- The `hubOpen(ctx)` → `resolveCommit` wiring (Round 2 caveat) is still unbuilt, because no caller exists yet. It must be reviewed when `FloatingActivity` lands.

**Executor behaviour.**
- It stopped and reported the ENOSPC block honestly rather than faking the spike.
- It wrote the tests red first and pasted the mutation log.
- One discrepancy: the commit message says "exec (deepseek)", but the Execution section is signed claude-opus-5-5, and the owner note requires Opus. This should be reconciled so the model attribution (§10) is true.

## Review

*— claude-opus-5-5, 2026-11-17* (H4a, `git diff main...HEAD`. Same model as the Execution signature, so only the context is fresh. The commit says "deepseek": the attribution is still unreconciled.)

**Verdict: REQUEST-CHANGES.** There is one MEDIUM finding.

**M1 — the "scroll once" rule breaks when it reaches the real screen** (`apps/mobile/src/screens/SessionScreen.tsx:572-578`).
- **Cause.** `revealOnLayout` reads `reveal` from the render closure and calls `setReveal(step.state)` with a plain value. All of the bands' `onLayout` callbacks in one layout pass see the same stale `reveal`, and the last write wins. The bands report in tree order (`schedules` before `mcp`/`skills`), so the state that sticks is the one from a later band. That state still has `want: "schedules"`, so the want is never spent.
- **Evidence.** `.tentacle/tmp/mobile-hub/rev-h4a/stale.ts` runs the real `revealStep` and simulates the batched pass:
  - `pass1 [200] want after: schedules`
  - `pass2 [290] want after: schedules`
- **Failure scenario.**
  1. The user taps "Scheduled wakes" and the sheet lands on the band.
  2. The user scrolls up to read Model or Session.
  3. Something moves or resizes the schedules band: the Session pull lands (its `loading` single row becomes Project/Devices), a row above it is expanded, or a wake fires and the table changes.
  4. The schedules band fires `onLayout` again, and the sheet yanks the user back to the band. This repeats every time until the band happens to be the last one to report in a pass.
- **Rule broken.** The Execution's own rule says "never re-scroll under the person's own scrolling". The pure tests pass because they never exercise the screen's closure, and `hub-scheduled-wiring` reads only the source.
- **Fix.** Use a functional update: `setReveal(prev => { const s = revealStep(prev, …); … })`, with the scroll side-effect taken out of the updater. Pin it with a test that drives two reports through the same captured state.

**Gate.**
- Touched files plus `band-notes`/`header-wiring`: 64 pass, 0 fail.
- `bun run lint`: clean (1782 files).
- `bun run typecheck`: clean (root, mobile and relay).
- Full `bun test`: not re-run.

**Mutations.** My mutation run was not approved in this session. I relied on the executor's log (14/14 killed, `S2` covers the want-spend rule in the pure module). Point M1 is exactly the gap that mutation does not reach.

**Attacks that found nothing.**
- §7 trust: wakes come only through `RemoteSession.onSchedules`, which is gated by `daemonWakes`, so a pod's table is never used. There is no new seam.
- `onSchedules` gives the current table immediately (`remote-session.ts:878-882`), so dropping the separate read is sound.
- `scheduledSection` uses `state.info.view`, which is always computed (it is not gated on the sheet being open). So the menu path does reach the band on first use.
- `wakeContext` uses the soonest wake and never reports a negative delay.
- No protocol, persistence or daemon surface is touched.

**Executor behaviour.** The as-built record is honest and detailed, and its mutation log was real. It missed that the pure rule's guarantee depends on how the component feeds it state.

### Round 2

*— claude-opus-5-5, 2026-11-17* (fix commit `e372699a`, `git diff HEAD~1`. Same model as round 1, fresh context only.)

**Verdict: PASS.**

**M1 is fixed.** The reveal state now lives in a `useRef` tracker (`apps/mobile/src/reveal-report.ts`, `SessionScreen.tsx:516`). `reportReveal` reads and writes `track.current` synchronously, one report at a time, so every band reported in one layout pass is folded in turn. The scroll runs outside any React updater. `reveal-report.test.ts` runs whole passes in tree order: the band is reached once, and a relayout afterwards never scrolls again.

**Mutations** (each reverted by hand; `git status` clean afterwards). Each of these makes a test fail:
- `reportReveal` no longer writes `track.current` (the stale-state bug): `reveal-report.test.ts` 6 pass, 4 fail.
- The screen folds into a fresh tracker on every layout instead of `revealTrack.current`: `hub-scheduled-wiring.test.ts` 5 pass, 2 fail.

**Other additions in the commit.** These are extras on top of M1: two earlier nits are now pinned (`dictation` passthrough, and the `ended` guard on the hub's Stop).

**Regressions.**
- `bun test apps/mobile/test/`: 2329 pass, 0 fail.
- `bun run lint`: clean (1784 files).
- `bun run typecheck`: clean (root, mobile and relay).
- Full `bun test`: not re-run.

**Note (not a finding).** The commit still says "(deepseek)", while this round's doc text is not signed. The model attribution (§10) is still worth reconciling.

### Fix round 1 (H4a)

*— claude-opus-5-5, 2026-11-17*

**Findings addressed:** the H4a Review's one MEDIUM (HIGH: none: M1). Also the
two nits that Review logged as surviving mutations (they are cheap to pin and
each is a real "a test that passes on both proves nothing" gap, AGENTS §9).

1. **M1 — the "scroll once" rule broke at the real screen. FIXED.** The cause is
   exactly as the Review stated: `revealOnLayout` folded each band's `onLayout`
   against `reveal` **from the render closure** and wrote it back with
   `setReveal(step.state)`, so every band of one layout pass folded onto the same
   stale state and the last write won. The last writer was a band *after*
   `schedules` in tree order, whose state still had `want: "schedules"` — so the
   want was never spent and the sheet re-scrolled on every later relayout.
   The fix is structural, not a `prev =>` patch, because the value was never
   render state to begin with: **the reveal draws nothing, it only decides one
   scroll.** It now lives in `apps/mobile/src/reveal-report.ts`, a pure module
   (AGENTS §7) holding a `RevealTrack` (`{ current: RevealState }`) that
   `SessionScreen` keeps in a `useRef`. `reportReveal(track, {id,y}, scroll)`
   reads **and** writes that ref synchronously, one report at a time, so the
   several reports of one batched pass are each folded in rather than
   overwriting one another, and the side effect (the scroll) is issued by the
   caller **outside** any React updater (StrictMode calls those twice — a
   functional-update patch would have scrolled on the discarded run too).
   `startReveal(track, id)` resets the measurements on each open, so a second
   open re-measures instead of scrolling to the previous open's stale y.
   The rule itself is unchanged and still `revealStep`'s: this module only owns
   *where the state lives* and *when the scroll is issued*.
2. **Review round 3's survivor — `stopTurn`'s `ended` guard.** FIXED (test only):
   `stopTurn` passing `ended: null` was 25/0. Now pinned with an OWN turn still
   streaming when the daemon's `closed` activity lands: a Stop that ignored
   `ended` aborts that stream (a local cancel the composer's own truth table
   refuses), and the test fails on exactly that.
3. **Review round 3's survivor — `hubContextOf`'s `dictation`.** FIXED (test
   only): hard-coding `dictation: false` was 9/0. Now asserted in both
   directions (the Dictate entry is offered from it, `hub-actions.ts:120`).

**Red before green.** The wiring guard was written first and run against the
unfixed screen:

```
bun test apps/mobile/test/hub-scheduled-wiring.test.ts   (fix NOT applied)
(fail) … the reveal's arithmetic lives in `session-info.ts`, never in the screen
       Expected to contain: "reportReveal(revealTrack.current, { id, y }"
(fail) … fix M1: no `useState` for the reveal — a render value loses a batched pass
 4 pass · 3 fail
```

The design assertion lives in `hub-scheduled-wiring.test.ts` (it is the source
guard for this screen, and it is what says the fold is the tracker's, not a
captured value); the behaviour lives in `reveal-report.test.ts`, which drives a
whole pass — every band reporting in tree order, which is the exact shape the M1
simulation used.

**Mutation checks** (`.tentacle/tmp/mobile-hub/fix1-m1-mut.ts`: apply one, run
`reveal-report.test.ts` + `hub-scheduled-wiring.test.ts`, restore the exact
bytes — `git status` was re-verified clean of the mutated files after each):

```
S1 the screen folds onto a captured copy (the render-value class): 15 pass · 2 fail
S2 the tracker never spends the want (a relayout re-scrolls):      11 pass · 6 fail
S3 startReveal keeps the old measurements (a new open scrolls early): 16 pass · 1 fail
S4 the fold loses earlier reports of the same pass:                16 pass · 1 fail
S5 a scroll for EVERY report, not only the wanted band:             9 pass · 8 fail
restored (unmutated):                                              17 pass · 0 fail
```

S3 survived the first run (17/0 before the test existed): that is what produced
the *"a second open re-measures"* case. The two nit mutations were run by hand
against `session-screen.test.ts` / `hub-session.test.ts`:

```
stopTurn's ended: transcript.closed → null:   24 pass · 1 fail
hubContextOf's dictation: input.dictation → false:  13 pass · 1 fail
restored:                                     25 pass · 0 fail / 14 pass · 0 fail
```

S1 is killed by the source guard, not by the pure tests — and that is the honest
division: the pure module cannot observe how a component captures its value. The
Review's own finding was found that way too (a source-independent rule that the
caller fed wrong), so the guard is where the class is pinned.

**Files.** `apps/mobile/src/reveal-report.ts` (new, 68 lines) ·
`apps/mobile/src/screens/SessionScreen.tsx:75-79,514-521,563-566,572-582` ·
`apps/mobile/test/reveal-report.test.ts` (new, 10 cases) ·
`apps/mobile/test/hub-scheduled-wiring.test.ts:41-62` ·
`apps/mobile/test/session-screen.test.ts` (+1 case) ·
`apps/mobile/test/hub-session.test.ts` (+1 case). No `useState` for the reveal
remains; `RevealState`/`REVEAL_IDLE`/`revealStart` are untouched in
`session-info.ts`, so `session-info-reveal.test.ts` still covers the rule as
before.

**Gate.** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit` clean ·
`bunx tsc -p apps/relay --noEmit` clean · `bun run lint` clean (1784 files, no
fixes) · `bun test` (full): **12996 pass, 5 skip, 0 fail** (13001 tests / 926
files; the 5 skips are the pre-existing opt-in docker/k8s/slow-socket set). No
protocol schema, persistence or daemon surface is touched, and the changelog
fragment is unchanged: H3's fan UI is still unbuilt, so the reveal is unreachable
from a shipped build and nothing user-visible changes in this round.

### H3 reopened (orchestrator, 2026-11-17 11:35)

H3 was logged "H1–H3 COMPLETE" on 2026-11-16 but **the fan was never built** (docs/fix/mobile-hub-longpress-dead.md, root causes 1–3: `FloatingActivity.tsx` is still the mobile-chrome F2 PanResponder, no hold timer, no `hub-gesture.reduce`, no fan component, no `playHaptic`, blank disc with no glyph). Do H3 now, as planned in this doc: **the load-bearing spike FIRST** (a PanResponder on the button keeps the touch over the transcript ScrollView for 400 ms + drag-select), then `HubFan.tsx` (radial fan A, the owner's pick), the gesture machine wired into the button, haptics (`open`/`commit`), the hub glyph on the idle button, the a11y ActionSheet, flow 29 — and the items H4a/H4b already registered (Scheduled, Artifacts) must appear in the fan. **Run it in the simulator** (own simulator, not the booted iPhone 17 Pro; e2e harness `bun apps/mobile/e2e/run.ts`, never port 4000) and put screenshots of the fan open (light/dark) in `.tentacle/tmp/mobile-hub/h3-shots/`. `changelog.d/mobile-hub.added.md` already describes the fan: H3 makes it true.
Simulator for H3: **iPhone 17** (UDID AF01E641-9EBC-4E39-B3C8-925DAE55807B). The QA sweep uses iPhone 17 Pro Max; the booted iPhone 17 Pro is shared — do not use it.

## Execution — H3 (redo after the reopen)

*— claude-opus-5-5, 2026-11-17*

**Load-bearing check (step 1): HOLDS.** Run on the assigned iPhone 17
(`AF01E641-…`, iOS 26.5), never the shared iPhone 17 Pro. Temporary spike:
`FloatingActivity`'s responder recorded its life instead of moving (moves,
max page distance from the grant, release, terminate) into a `spike-result`
text; a temporary flow 28 swiped from the button UP over the transcript
`ScrollView`, then LEFT (`duration: 2500` each), then `longPressOn`. Run
`.tentacle/tmp/e2e-mobile/1794912243307` — **PASS**:
```
swipe UP   → spike moves=155 max=659 released=1 terminated=0   (transcript did not scroll: shot h3-shots/spike-1-up.png)
swipe LEFT → spike moves=… released=1 terminated=0              (asserted by regex)
longPress  → spike moves=0 max=0 released=1 terminated=0
```
The button keeps the finger 659 pt away, over the `ScrollView`, and is never
terminated: no gesture library is needed. (The first attempt,
`…/1794911312072`, failed before any step: on the fresh simulator's first boot
the Face ID match fell back to the passcode sheet; a re-run passed.) Both spike
files were restored from `.tentacle/tmp/mobile-hub/spike2/` copies.

**Done, in order:**
1. `e2e/run.ts`: `firstDevice(json, major, prefer?)` + `--udid` (`E2E_SIM_UDID`
   too) so a run can target a dedicated simulator; `test/e2e-preflight.test.ts`
   red (`Expected "own", Received "booted"`; then the `--udid` parse case) → green.
2. `src/hub-session.ts` (pure, +tests in `test/hub-session.test.ts`):
   `createHubDriver` (the reducer + its ONE 400 ms timer, injected clock/timers:
   armed on the press, cleared on every way out of `pressing`, `dispose` closes an
   open fan — M2/M4/M12/M13/M16), `isFanOpen`, `commitPlan` (`resolveCommit` →
   run / more / notice / none), `hubA11yActions` + `hubA11yRoute` (Design 7).
   Red: import failure first, then the fake-timer case (a rig bug: a fired timer
   stayed in the map — fixed in the rig, not the code); green 30/0.
3. `src/ui/Composer.tsx`: `focusKey` (each new value focuses the field: Steer).
4. `src/ui/HubFan.tsx` (new, render only): scrim (the sticky tap target, band
   coordinates = its local point), the items at `fanLayout`'s spots, staggered
   spring per `fanMotion` (fade under Reduce Motion), highlight ×1.3 + dim,
   `labelPlacement` for the highlighted item's pill, Stop red, item badges.
5. `src/ui/FloatingActivity.tsx` rewritten: the responder feeds `bandPoint`
   points into `createHubDriver`; effects → haptic (`hubHaptic`), open (fan, or
   `onMenu` when the layout is `menu`), highlight, commit, close, tap, dragTo /
   drop (S10's snap kept) / dragCancel. `mustCancel` on every world change
   (sheet/drawer, VoiceOver, band size). `onFanChange` on every change and on
   unmount. Idle glyph = 2×2 dot grid (`hub-glyph`); a count badge
   (`hub-badge-count`) or a new-dot (`hub-badge-dot`) per `buttonBadge`; a
   spinning accent arc while a turn runs (static under Reduce Motion);
   `accessibilityActions` = `hubA11yActions(all)`, routed by `hubA11yRoute`.
6. `src/screens/SessionScreen.tsx`: `openAttach()` (ONE chooser for the
   composer's photo button and the hub); the `entries` record (stop →
   `controller.stopTurn()`, steer → `focusKey`, attach, activity, info,
   scheduled (H4a), sessions → drawer, new → drawer's New session, artifacts →
   gallery `"hub"` (H4b), dictate → `voice.tapMic()`); `hubContextOf` with the
   wakes AND the artifacts seen record; `commitPlan` at release against the
   open's snapshot (a VoiceOver action against now); the More / menu / VoiceOver
   `ActionSheet` (`hub-menu-sheet`, haptic `light`); `hub-notice` ("Already
   finished"); `navigation.setOptions({gestureEnabled: !open})` (M2); the hub
   menu also counts as "covered".
7. `App.tsx`: the drawer host's render prop passes New session down;
   `SessionRoute` passes `onNewSession` and `artifactsSeenKey`
   (`sessionKey(computerId, sessionId)`).
8. `e2e/flows/33-hub.yaml` + registered in `FLOWS` / `COMPOSE_SESSION_VARS`
   (`HUB_ID`). **PASS** on the iPhone 17 (`…/1794913276348`, first run): glyph
   at zero activity; long-press → sticky fan, `hub-item-attach` +
   `hub-item-activity`; tap Attach → "Add an attachment" → Cancel; long-press →
   tap outside → fan gone, nothing ran; `HOLD hub` → long-press →
   `hub-item-stop` + `hub-item-steer` → tap Stop → `turn-idle`; tap = Activity;
   Header → no hub. Shots (light/dark, idle and running) in
   `.tentacle/tmp/mobile-hub/h3-shots/` (`33-hub-fan-*.png`): the running fan
   shows Stop (red), Steer, Activity, Artifacts, Attach, More on two rings, the
   arc spinning on the button.

**Mutations** (`bun .tentacle/tmp/mobile-hub/spike2/mutate-h3b.ts`, exact bytes
restored; the plan's own target — `stopTurn` calling `act()` — was run in the
2026-11-16 round: S1, 2 fail):
```
D1 timer not cleared on leaving pressing: 27 pass, 3 fail — a release before 400 ms …
D2 timer re-armed on every pressing step: 29 pass, 1 fail — a second finger's down …
D3 dispose leaves an open fan open:       29 pass, 1 fail — dispose with the fan open …
C1 commitPlan: More runs as an entry:     29 pass, 1 fail — a live entry runs; More opens …
C2 commitPlan drops the notice:           29 pass, 1 fail — Stop on a turn that ended …
A1 a11y: no Show all:                     29 pass, 1 fail — every action (no six cap) …
A2 a11y: long-press is a tap:             29 pass, 1 fail — activate = tap …
```

**Drift from the Implementation (and why).**
- The flow is **33-hub**, not 29: `29-tool-rows` took the number meanwhile.
  The fan shots are in flow 33 (both themes, via `_shot`), not added to 24.
- Files outside the plan's list: `hub-session.ts` grew the driver / commit /
  a11y seam (§7: the timer, the routing and the commit verdict are tested
  there, not in a `.tsx`); `App.tsx` (New session and the artifacts seen key
  live only there); `e2e/run.ts` `--udid` (to honour "own simulator").
- Scrim: one `palette.scrim` at opacity 0.4 (≈0.14 in both themes), not the
  plan's light 0.12 / dark 0.30. Palette carries no theme flag; a later
  visual pass may add a token.
- Labels: only the highlighted item has one (Design 3), so a sticky fan shows
  icons only. As designed; noted for the owner.
- `bun install --frozen-lockfile` was needed once: `linkedom`/`mermaid`
  (declared by `packages/tools`, in `bun.lock`) were not installed in this
  worktree, so root `tsc` failed on `diagram-parse.ts`. No lockfile change.

**Not driven (stated):** press-slide-release on device (Maestro's swipe is a
drag: pinned by `hub-gesture` + the driver tests, and the spike for the
responder); the back-swipe after a close (M2, no Maestro edge gesture);
VoiceOver / Reduce Motion (pure tests); the More sheet on device (the fan had 6
items, More appeared in the running fan but was not tapped).

**Gate:** `bun run typecheck` clean · `bun run lint` clean (1988 files) ·
`bun test` 14491 pass / 5 skip (all env-gated live/opt-in files) / 0 fail.
`changelog.d/mobile-hub.added.md` unchanged — H3 makes it true (the Artifacts
count is now wired). No schema change (no protocol.json regeneration).

**Status: H3 DONE.**
