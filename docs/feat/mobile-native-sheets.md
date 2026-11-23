# feat/mobile-native-sheets — native iOS sheets with three detents

Type: feat · Size: M–L (split if the plan says so) · Blast: cross-module (every sheet in the app) · Suited: Opus plan, DeepSeek exec (one at a time), Opus review, simulator shots

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Owner 22/11 ~18:50: «native-quality bottom sheets with 3 detents (short/medium/large), perfection in small things». Mockup of the proposal: https://claude.ai/artifact/TX2qs8Rsvk9smZqkDqvGDM (proposal A = native iOS `formSheet` via `react-native-screens` 4.30.1, `sheetAllowedDetents`). Owner 23/11 ~07:30: **A, three-detent sheets — but keep the transitions when tapping workflow tasks** (the agent-workflows node→detail morph + skeleton stays; the alternative «transitions for places you enter» mockup https://claude.ai/artifact/2jyn5wcCgJ1sJyWAjBPPTs is NOT adopted elsewhere).

Today every sheet is RN `<Modal presentationStyle="pageSheet">` (verified 23/11): `apps/mobile/src/screens/ToolsSheet.tsx:130`, `SessionInfoSheet.tsx:369`, `compose/OutboxDecisionSheet.tsx:53`, `CommandsSheet.tsx:294`, `PermissionSheet.tsx:133`. Out of scope: `LockGate.tsx:201` (fullScreen), `ui/diagram/DiagramFullScreen.tsx:63`, `ui/chart/ChartFullScreen.tsx:103` (full screen by design). `react-native-screens` is already a dependency (4.30.1); `react-native-reanimated` is NOT.

Questions the plan must answer from the source: how the app navigates today (is there a native stack at all, or plain RN views + Modals? a `formSheet` needs a screen in a native stack); which detents each sheet gets and which it opens at (e.g. Permission = medium, never dismissible by a stray swipe while an ask is pending; Commands = medium→large; Tools/Info = medium→large; Outbox decision = short); grabber, corner radius, background dimming per detent, keyboard (Rename field) and scroll-to-expand behaviour; Reduce Motion; Dynamic Type; dark/light/petrol; haptics; what the e2e flows (Maestro, `apps/mobile/e2e/flows/`) need to keep finding the same elements; Android is not a target. Owner UI rules: no rounded inset cards, no pure black, thin icons, never meaning by hue alone, an empty entry is dimmed + light haptic + inline label (never an empty sheet).

## Implementation

*— claude-opus-5-5 (planner), 2026-11-23*

Size **L** in total (split into six S/M slices below) · Blast **cross-module** (the
navigator + every sheet; no protocol/persistence change; the permission sheet's
broker wiring is untouched) → strong executor per slice, **mandatory
fresh-context Review**. Changelog: `changelog.d/mobile-native-sheets.changed.md`.

RNS = `react-native-screens@4.30.1`, NS = `@react-navigation/native-stack@7.21.0`
(both exact pins, `apps/mobile/package.json`). The worktree has no
`node_modules`; the sources were read from the Bun cache
(`~/.bun/install/cache/react-native-screens@4.30.1@@@1/…`,
`…/@react-navigation/native-stack@7.21.0@@@1/…`, `…/@react-navigation/routers@7.6.5@@@1/…`,
`…/react-native@0.88.0@@@1/…`). After `bun install` they are the same files under
`node_modules/`.

### Load-bearing assumption

**A sheet can be a native `UISheetPresentationController` formSheet with custom
detents and still take its state and callbacks from `SessionScreen`, where they
live today. The sheet has to be presented in the native stack's presentation
context, so the lock cover still goes above it.**

What the source proves:

1. **Today no sheet is a route.** All five are RN `<Modal presentationStyle="pageSheet">`
   mounted inside `SessionScreen` (`SessionScreen.tsx:1728-1862`). Their open flags and
   inputs are screen state (`:902`, `:909-918`, `:932-934`) or controller state
   (`state.sheet`, `state.commands`, `state.info`). RN `Modal` has no detents at all
   (`react-native@0.88.0/Libraries/Modal/Modal.js:105-106`: only the
   `presentationStyle` enum).
2. **There is a native stack** (`App.tsx:218` `createNativeStackNavigator`, `:2548-2821`),
   and NS forwards every sheet option to RNS: `presentation` (NS `types.tsx:682`),
   `sheetAllowedDetents` (`:701`), `sheetExpandsWhenScrolledToEdge` (`:719`),
   `sheetCornerRadius` (`:728`), `sheetInitialDetentIndex` (`:740`),
   `sheetGrabberVisible` (`:748`), `sheetLargestUndimmedDetentIndex` (`:768`). They
   reach `ScreenStackItem` in `NativeStackView.native.tsx:460-471`, with the defaults
   at `:199-205` (`[1.0]`, `-1` = always dimmed, no grabber, system radius,
   expand-on-scroll on, initial `0`).
3. **RNS gives a formSheet only as a stack `Screen`** (`stackPresentation: 'formSheet'`,
   RNS `src/types.tsx:45,589`). That is the API the owner's proposal names
   (`sheetAllowedDetents`). Its iOS side builds custom detents as a fraction of
   `maximumDetentValue` (`ios/RNSScreen.mm:1100-1107`). That needs iOS 16
   (`:1020`); the app targets 18.0 (`app.json`, `expo-build-properties`
   `ios.deploymentTarget`).
4. **The one alternative that keeps the state in the screen is rejected.** RNS ships an
   experimental declarative `FormSheet` with `isOpen` (`src/components/gamma/modals/form-sheet/FormSheet.types.ts:32`,
   exported only from `react-native-screens/experimental`, `src/experimental/index.ts:1-4,12`).
   It is rejected on three counts:
   (a) its iOS code is compiled only when `RNS_GAMMA_ENABLED=1` is set at `pod install`
   (`RNScreens.podspec:5,54-58`). Without the flag the host is an empty stub
   (`ios/stubs/RNSGammaStubs.mm:18-22`) and the sheet silently never appears.
   (b) It presents from the window's root/top-most VC
   (`ios/gamma/modals/utils/RNSPresentationSourceProvider.mm:12-27`). The lock cover is
   an RN `Modal` that presents on its own `reactViewController`, the root
   (`React/Fabric/Mounting/ComponentViews/Modal/RCTModalHostViewComponentView.mm:149-155`).
   A root that is already presenting the sheet cannot also present the lock. That would
   break the lock's verified fact 3 (`docs/feat/mobile-lock.md:83-86,379`), which was
   proven against a **native-stack** formSheet.
   (c) "Breaking changes without notice".
5. **So the plan uses the stable engine: one formSheet route that renders what `SessionScreen`
   publishes.** There is a precedent: the gallery, a sibling route, already reads what
   the session screen publishes through a module-level registry
   (`src/artifact-feed.ts:6-12,72-134`, consumed at `App.tsx:1813` and
   `ArtifactGallery.tsx:120`). The screen under a modal-style route stays mounted and
   keeps rendering. NS renders every route in `state.routes`
   (`NativeStackView.native.tsx:609`), and nothing freezes it: `freezeOnBlur` defaults
   to false (NS `types.tsx:829`) and the app never calls `enableFreeze` (grep:
   no hit in `App.tsx`/`src`).

The static reading cannot settle the rest: live content in a route, native-dismiss sync,
the lock, and foreign modals. **Step 0** proves those on the simulator before any
product code. If F1 or F2 fails → STOP and report (two-strike, AGENTS §0).

### Step 0 — simulator spike (throwaway, nothing kept)

Write a throwaway patch in the worktree: a `SheetSpike` formSheet route in `App.tsx`
plus a button in `SessionScreen` that pushes it. The route renders a `ReactNode` that
`SessionScreen` publishes through a tiny registry, with a live 1 s counter. Save the
diff to `.tentacle/tmp/mobile-native-sheets/spike.patch`. Revert it with
`git apply -R` (no stash, no checkout). Record each fact with a screenshot in Execution.

| # | Fact to prove | Pass |
|---|---|---|
| F1 | Route `presentation:"formSheet"`, `sheetAllowedDetents:[0.3,0.5,1]`, `sheetInitialDetentIndex:1`, `sheetGrabberVisible:true` over `Session`: opens at the middle detent, the published counter keeps ticking, drag reaches all 3 detents | all |
| F2 | Native swipe-down removes the route. A `navigation.addListener("state")` in `SessionScreen` sees it go (NS `onDismissed` → keyed `pop`, `NativeStackView.native.tsx:122-138`) | listener fires once |
| F3 | `gestureEnabled:false` → swipe and backdrop tap don't dismiss (RNS sets `modalInPresentation`, `RNSScreen.mm:359`; `presentationControllerShouldDismiss` → NO, `:676-682`). Dragging between detents still works, and the `gestureCancel` event arrives (`:684-692` → NS `:156-161`) | all |
| F4 | `navigation.push` of a second sheet while one is up → it stacks (RNS presents from the previous modal, `RNSScreenStack.mm:572-579`). A keyed pop of the TOP removes only it. Popping the LOWER one: record what happens (expected: dismiss-all + re-present flash, `:596-637`) | top-pop clean |
| F5 | (a) Sheet up → background with lock `immediately` → return: lock above sheet (fact 3 re-run). (b) While locked, push a sheet: record where it lands (expected ABOVE the cover: RNS falls back to the top-most VC from the react root, `RNSScreenStack.mm:640-650`) | (a) pass; (b) recorded |
| F6 | (a) `ActionSheet` (RN `Modal`) open → push a sheet route: record (expected: RNS dismisses the foreign modal, `:596-623`, issue 2048). (b) Sheet route up → open an RN `Modal` from `SessionScreen`: record (expected: not shown, since the presentation context is already presenting) | recorded |
| F7 | Baseline on current code: Tools sheet open, then a permission ask arrives → does `perm-sheet` show? (two RN `Modal`s from one VC) | recorded (likely a pre-existing bug) |
| F8 | Head fixed + ONE inner `ScrollView` → scroll-to-edge expands medium→large. Nested ScrollViews (today's `Sheet scroll` + inner list) → record | single works |
| F9 | `TextInput` in a 0.5 sheet focused: the field and the button under it stay above the keyboard (RNS notes the native resize, `src/types.tsx:504-507`) | visible |

### Preconditions (verified)

- **Single broker untouched.** The permission sheet object (`PermissionSheet`,
  `permission-sheet.ts:148-170`) keeps being created and owned where it is now. Only
  its view moves (into the route). `dismiss()` keeps today's meaning: withdraw and send
  nothing; the ask stays pending (`:501-513`).
- **Lock state is one value:** `LockView.cover`/`locked` (`app-lock.ts:54-63`), held in `App.tsx`.
- **Keyed pop is safe against double-close.** `POP` with `source` = a missing key
  returns `null`, a no-op (`routers/src/StackRouter.tsx:557-565`). A key in the middle
  removes only that route (`:567-578`). An unkeyed `goBack()` from the Session's
  `navigation` would pop **Session** itself, so it is banned in sheet code.
- **Initial detent is applied once per presentation** (`RNSScreen.mm:1020-1036`,
  `_sheetHasInitialDetentSet`). There is no runtime "go to detent N" API, so the only
  detent decision is the opening one. `sheetDetentChange` reports changes
  (`NativeStackView.native.tsx:163-172`).
- **RNS dev-asserts the detent config.** Unsorted detents throw in dev
  (`src/components/helpers/sheet.tsx:11-19`). Out-of-range undimmed/initial indexes
  throw in dev (`:58-66`, `:92-99`). The pure module must make those states impossible.
- **Transitions are not customisable for formSheet** (NS `types.tsx:660-666`). Reduce
  Motion is therefore the system's. No custom JS animation is left in these five sheets.
- **Focus will change.** `SessionScreen` uses `useIsFocused()` for the voice gates
  (`SessionScreen.tsx:357-374`, `voice-controller.ts:337-341`). A sheet route on top
  blurs Session, so with no fix, auto-read of an ask would stop exactly when the
  permission sheet opens.
- **Out of scope, unchanged:** `ActivitySheet` is a JS sheet (`ActivitySheet.tsx:319-325`,
  `activity-panel.ts`). The workflow node→detail morph (`workflow-morph.ts`, today only
  tested, not yet wired) belongs to that surface, so the owner's "keep the transition"
  holds by not touching it. Also out of scope: `RenameSheet` (an alert,
  `RenameSheet.tsx:33`), `ActionSheet` (`ui/ActionSheet.tsx:47`), `LockGate`, the
  Diagram/Chart full screens, and `PairScreen`'s floating `Sheet`.
- The app sets no orientation, so landscape is live (`ui/chart/ChartFullScreen.tsx:50`).

### Design

**D1 — one route, five kinds.** `RootStackParams` gains
`Sheet: { computerId; sessionId; kind: SheetKind }` (`routes.ts:79-88`). `App.tsx`
declares one `Stack.Screen name="Sheet"` with
`options={({route}) => ({ headerShown:false, ...sheetOptions(route.params.kind, ctx) })}`.
Opening uses `navigation.push` (never `navigate`: a second `Sheet` must stack, not
replace params). Closing uses a keyed `pop` of that route's key.

**D2 — content bridge (`sheet-host.ts`, pure).** This is the `artifact-feed.ts` shape:
`SHEET_HOSTS.host(computerId, sessionId)` → `{ publish(kind, content: unknown),
current(kind), subscribe, forget }`. `SessionScreen` builds the SAME sheet elements as
today, but without `<Modal>`, and publishes them in a layout effect. `NativeSheetRoute.tsx`
renders `useSyncExternalStore(host.subscribe, () => host.current(kind))`. If nothing has
been published (orphan route after an unmount), the route pops itself. It never draws an
empty sheet (owner rule).

**D3 — decisions (`sheet-plan.ts`, pure, React-free).** This is the one place that
decides *which sheet* and *which detent*:
- `SHEET_SPEC: Record<SheetKind, SheetSpec>` (table below) and
  `sheetOptions(kind, { fontScale, asking })` → the NS option object. It guarantees
  sorted detents and an in-range initial index (the RNS dev asserts above).
  `gestureEnabled = !(kind === "permission" && asking)`.
- `initialDetent(kind, { fontScale, reveal })`: the spec's index, raised one step when
  `fontScale ≥ DENSE_FONT_SCALE` (1.4, `theme.ts:350`) and set to the largest when
  Session info opens with a reveal (`openScheduled`, `SessionScreen.tsx:993`).
- `desiredStack({ user: "commands"|"tools"|"info"|null, outbox: boolean, permission: boolean })`
  → bottom→top kinds. At most one user sheet; outbox above it; permission always on top.
- `reconcile(desired, actual: {kind,key}[], { hidden, transitioning })` → ONE next step:
  `push kind` | `pop key` | `null`. It only ever pops the **top**: a lower sheet that
  must go waits until the sheets above it are gone (no F4 flash). Nothing runs while
  `transitioning`, **except the drain**.
  *Lock drain (owner decision A, Step 0b; revised by claude-opus-5-5, 2026-11-23):*
  `hidden = locked || appState !== "active"`. While `hidden`, the step is always
  `pop top`, and it does not wait for `transitioning`. The screen applies it repeatedly in
  one pass until `actual` is empty (Step 0b: the stack empties ~6 ms after `inactive`,
  ~1 s before `background`). `desired` is untouched, and the drain's pops are planned, so
  `dismissedNatively` reports nothing and no close handler runs (an ask stays pending,
  L4). While `hidden` there is never a `push`. When it turns false, the normal steps
  re-push `desired` bottom→top, each at its remembered detent.
  `inactive` is the load-bearing leg (JS may see no `background` before the resume). `locked`
  gates the `active`-while-locked window, so it must come from the lock instance's own
  subscription, never from `AppShell`'s render-time `lockView` (stale, Step 0b).
- `rememberDetent(kind, identity, index)` / `openingDetent(kind, identity)`: the last
  stable `sheetDetentChange` per sheet identity (user sheets: the kind; Permission: the
  ask's request id). A re-push uses it, otherwise `initialDetent`. Permission's `desired`
  entry is keyed on the ask identity. A re-delivery of the SAME ask on resume
  (`idle → asking` within one resume, Step 0b L3) therefore keeps its detent. A *different* ask
  opens at the spec's detent.
- `dismissedNatively(prevActual, nextActual, lastPlannedPop)` → kinds the person swiped
  away → the screen runs that kind's existing close handler (`closeTools`,
  `closeCommands`, `setDeciding(null)`, the info close at `:1814-1818`).
- `afterDismiss` queue: intents that need the sheet gone first. These are Commands →
  Rename (`renameFromCommands`, `:1016-1019`; Rename is an RN `Modal`, so F6b) and
  Info → Artifacts (`:1806-1813`). They run on the route's `transitionEnd {closing:true}`.
- `yieldForeign(desired, actual)` → true while a sheet is about to be pushed or is up.
  The screen then hides its RN-Modal surfaces: the hub/session `ActionSheet`s close,
  `ActivitySheet` closes, and `RenameSheet` is hidden while its text survives in the
  controller (`state.renaming`), showing again once no sheet is up. This removes F6a/b
  by construction.
- `sessionInFront(focused, actual)` = `focused || actual.length > 0` (the top routes
  are this session's sheets). It replaces the raw `focused` passed to the voice gates.

**D4 — components only render.** Each sheet component loses `<Modal>` and `visible`.
`ui/Sheet.tsx` gains `native?: boolean` (default false, so `PairScreen` is unchanged):
no drawn grabber (`:89`, the native one replaces it), no top radius, and the head (title,
subtitle, close) is pinned with ONE inner scroller. That replaces the nested
`Sheet scroll` + inner `ScrollView` in Tools (`ToolsSheet.tsx:134-144`) and Info
(`SessionInfoSheet.tsx:373-388`) (F8). `PermissionSheet` drops its own grabber (`:146`)
and keeps `automaticallyAdjustKeyboardInsets` + scroll-to-end (`:117-129,141`).

**D5 — permission dismiss.** While `asking`, swipe and backdrop are blocked
(`gestureEnabled:false`). Each blocked attempt (`gestureCancel`) plays the `light`
haptic and shows an inline footnote under the options (`perm-hold`: "Answer to continue
— or Not now"). A new text button `perm-later` ("Not now") calls `sheet.dismiss()`,
today's swipe semantics, made explicit. `returned` stays swipe-dismissible. *(Owner Q2.)*

**Per-sheet table** (S/M/L = `[0.3, 0.5, 1.0]` of the max detent height, *Owner Q1*;
grabber on; dimmed at every detent; system corner radius; scroll-to-expand on):

| Sheet | Detents | Opens at | Dismiss | Keyboard | Scroll |
|---|---|---|---|---|---|
| Permission | S·M·L | M; L if fontScale ≥ 1.4 | blocked while asking (haptic + `perm-hold`), `perm-later` withdraws; free when returned | reply field: content insets + scroll-to-end; UIKit lifts the sheet | one ScrollView, expands to L at edge |
| Outbox decision | S·M·L | M (5 pills + quote ≈ 420 pt don't fit S, *Owner Q1*); L if ≥ 1.4 | swipe = "Not now" (`setDeciding(null)`) | none | one ScrollView |
| Commands | S·M·L | M | swipe = close; the sheet stays open during Compact (C2) | none (Rename opens AFTER the dismiss) | short list; expands |
| Tools | S·M·L | M | swipe = `closeTools` | search field: UIKit lifts; list `keyboardShouldPersistTaps` | pinned head + segments/search; list expands to L |
| Session info | S·M·L | M; **L when opened with a reveal** | swipe = info close | none | pinned head; list expands to L; reveal scrolls inside |

Colours: route `contentStyle` = `palette.bg` (the banded ground, `ui/Sheet.tsx:9-13`),
`palette.sheet` for Permission. It works in light, dark and petrol (`theme.ts:204,238`).
Pure black and inset cards: none are added.

### Files (dependency order)

1. `apps/mobile/src/sheet-plan.ts` (new) + `test/sheet-plan.test.ts`
2. `apps/mobile/src/sheet-host.ts` (new) + `test/sheet-host.test.ts`
3. `apps/mobile/src/routes.ts` (`Sheet` param type, `SheetKind` re-export)
4. `apps/mobile/src/screens/NativeSheetRoute.tsx` (new, render only)
5. `apps/mobile/App.tsx` (`Stack.Screen name="Sheet"`; pass `lockView.locked` into `SessionRoute`)
6. `apps/mobile/src/ui/Sheet.tsx` (`native` variant)
7. `apps/mobile/src/screens/{CommandsSheet,compose/OutboxDecisionSheet,ToolsSheet,SessionInfoSheet,PermissionSheet}.tsx` (drop `Modal`/`visible`)
8. `apps/mobile/src/screens/SessionScreen.tsx` (publish, reconcile effect, `state` listener, yield, `sessionInFront`)
9. `apps/mobile/test/native-sheets-wiring.test.ts` (new, source-structure pattern of `hub-tools-wiring.test.ts:10-34`)
10. `apps/mobile/e2e/flows/{08c-permission-reply,25-session-info,29-tool-rows,34-hub-*}.yaml` + a new `42-native-sheets-shots.yaml`
11. `changelog.d/mobile-native-sheets.changed.md`

### Slices (each S/M, narrow test file per slice, red first)

- **S1 (S):** `sheet-plan.ts` + tests. Pure, no UI change.
- **S2 (S):** `sheet-host.ts`, the route type, `NativeSheetRoute`, the `App.tsx` screen. Nothing pushes it yet. Wiring test: the route exists and is `formSheet`.
- **S3 (M):** `SessionScreen` reconcile loop + native-dismiss sync + **lock drain (A)** + yield +
  `sessionInFront`. Migrate **Commands** and **Outbox** (no keyboard, simplest).
  The drain's inputs: `AppState` (`inactive`/`background` ⇒ hidden) and `locked` from a
  subscription on the lock instance (`app-lock.ts`). Add one if none exists. Do NOT use
  `AppShell`'s `lockView`. Detent memory per identity (D3). Tests: `reconcile` drains
  top-down while `hidden` even while `transitioning`, never pushes while `hidden`, and
  re-pushes in order after it. Planned drain pops are not reported as swipes. A
  re-delivered ask with the same id keeps its detent (red first). The gate flow for L1
  (lock `immediately` + Home + relaunch with a sheet up → `lock-screen` visible) goes into S6.
  *— claude-opus-5-5, 2026-11-23 (Step 0b).*
- **S4 (M):** `Sheet native` variant. Migrate **Tools** and **Session info** (pinned
  head, reveal at L, close-then-push to Artifacts).
- **S5 (M):** Migrate **Permission** (D5, keyboard).
- **S6 (S):** e2e flow updates + simulator Validation.

### Failure modes → how state converges

- **Sheet opened while another is up** (a user sheet over a user sheet): `desiredStack`
  holds one user sheet, so the old one is popped (top-only), then the new one is pushed
  on its `transitionEnd`.
- **Permission ask mid-sheet:** pushed on top of whatever is up (F4). When it is answered,
  its pop is keyed. A lower sheet is never popped under it. Today's behaviour (F7) is
  recorded as evidence. If it is the expected silent drop, the fix lands here, with a
  test.
- **Lock / app switcher with sheets up** (A, Step 0b): on `inactive` (or `locked`) the
  stack is drained top-down. The lock `Modal` then presents on a root that is no longer
  presenting (L1). `desired` survives, and on unlock the same sheets return at their
  detents (L3), the ask still pending (L4). Rapid lock/unlock converges (L5).
  *— claude-opus-5-5, 2026-11-23.*
- **Ask while locked:** no push while `hidden`. Then reconcile pushes it. The ask stays
  in `state.sheet` meanwhile (nothing is lost).
- **Resume flicker of an ask** (`idle → asking` on link resume, Step 0b): the identity-keyed
  entry and the remembered detent mean the same ask returns at its detent.
- **Control Center / a call banner / the Face ID prompt** (`inactive` without leaving): these
  also drain, and the sheets re-push on `active`. That is a visible dismiss + re-present,
  a direct consequence of draining on `inactive`. Not seen on the simulator. **Owner to
  confirm it is acceptable** (Step 0b).
- **Native swipe vs. programmatic close race:** `dismissedNatively` ignores the key it
  just popped itself. A keyed pop of a missing key is a router no-op, so Session is
  never popped.
- **Orphan route** (session screen gone: drawer `replace`, notification `reset`): the
  host is empty, so the route pops itself. `forget` runs on unmount.
- **Rotation:** detents are fractions that UIKit re-resolves (`RNSScreen.mm:1100-1107`).
  In compact-height landscape the sheet is UIKit's full-height style. One landscape shot
  per sheet goes in Validation.
- **Keyboard:** UIKit resizes the sheet (F9). Content insets stay as today (Permission).
- **Reduce Motion:** system presentation only (NS `types.tsx:660-666`). Verify with the
  setting on.
- **Dynamic Type:** contents scroll at every detent. The initial detent is raised at
  ≥ 1.4. AX5 shots go in Validation.
- **Foreign RN modals** (ActionSheet, Rename, Activity, MediaViewer): `yieldForeign`
  keeps them closed or hidden while a sheet is up. Rename's text survives.
- **Voice gates:** `sessionInFront` keeps an ask's auto-read working when its own sheet
  blurs Session.
- **e2e selectors:** every testID is unchanged (`perm-sheet`, `perm-<id>`,
  `tools-sheet`, `tools-close`, `session-info-sheet`, `session-info-close`,
  `commands-sheet`, `outbox-decision`, `outbox-close`, …). New: `perm-later`,
  `perm-hold`. Elements below the M fold need a `scrollUntilVisible` (e.g. flow 25
  already scrolls for skills, `25-session-info.yaml:60-63`; `08c` reply-send, `29`,
  `34-hub-*` to check). 21 flows reference sheet ids (grep `id: "(tools|session-info|commands|command|outbox|perm)`).

### Tests (red first, AGENTS §9)

- `sheet-plan.test.ts`:
  - every spec is sorted, its initial index is in range and the undimmed index is valid
    (mutation check: swap two detents → red);
  - `desiredStack` precedence (permission on top, one user sheet);
  - `reconcile` never pops a non-top key, never pushes while `locked`/`transitioning`,
    and converges in ≤ n steps from any actual stack;
  - `dismissedNatively` ignores its own pop;
  - `initialDetent` handles fontScale and reveal;
  - `gestureEnabled` is false only for permission+asking;
  - `yieldForeign`; `sessionInFront`.
- `sheet-host.test.ts`: publish/subscribe/forget, per-session isolation, and orphan
  detection.
- `native-sheets-wiring.test.ts` (source-structure):
  - no `presentationStyle="pageSheet"` is left in the five files;
  - `SessionScreen` opens with `push("Sheet"` and closes with a keyed pop, with no
    `goBack(` in sheet paths;
  - voice gates read `sessionInFront`;
  - `perm-later` calls `sheet.dismiss`.
  Each assertion is shown red on current `main` before the slice.
- Existing suites stay green: `permission-sheet*.test.ts`, `commands-sheet.test.ts`,
  `tools-view.test.ts`, `session-info*.test.ts`.

### Validation (simulator, not automatable)

iPhone 17-class simulator. For **each of the 5 sheets × each detent (S, M, L) × light
and dark**, plus petrol at M: 35 screenshots saved to
`.tentacle/tmp/mobile-native-sheets/shots/`, and the list pasted into Execution. Also:
- Permission over Tools;
- lock with a sheet up;
- ask arriving while locked → after unlock;
- Tools search with keyboard at M;
- Permission reply with keyboard;
- Reduce Motion on;
- AX5 Dynamic Type at M (Outbox, Permission);
- landscape (one sheet);
- a blocked swipe on Permission (`perm-hold` shown).

Then run the full e2e gate. Finish with `bun run check` green (lint baseline: 0/0).

### Owner questions

1. **Detent heights and Outbox's opening detent.** The proposal mockup could not be read
   from here. *Recommendation:* S/M/L = 0.3/0.5/1.0 for all five sheets. Outbox opens at
   **M**, not S: its title, quote and 5 pills (≈ 420 pt) don't fit 0.3. A mockup of
   Outbox at S vs. M decides it if the owner prefers short.
2. **Permission while asking.** Should it be non-dismissible by swipe/backdrop, with an
   explicit "Not now" (`perm-later`, same effect as today's swipe), a light haptic and an
   inline "Answer to continue" on a blocked swipe? *Recommendation: yes*, as in D5.
   Undimmed-at-S (so the chat stays tappable under a peeking ask) is NOT recommended now:
   it lets taps reach the composer during an ask.
3. **Activity sheet.** Keep it as the JS sheet in this task (it will carry the workflow
   morph the owner chose to keep)? *Recommendation: yes, keep it.* Revisit after this
   task lands.

## Execution

### Step 0 — results

*— claude-opus-5-5, 2026-11-23*

How it ran: a throwaway patch (`SheetSpike` route in `App.tsx`: `presentation:"formSheet"`,
`sheetAllowedDetents:[0.3,0.5,1]`, `sheetInitialDetentIndex:1`, `sheetGrabberVisible:true`,
`gestureEnabled` per param; `src/sheet-spike.tsx` = a module registry +
`useSyncExternalStore`, a 1 s counter published by `SessionScreen`, a `state` listener
counting removed `SheetSpike` keys, push / keyed-pop / RN-Modal buttons) plus a gate flow
`99-sheet-spike` (registered in `e2e/run.ts` for the run only). Three gate runs on simulator
`0B43D716…` (iOS 26, dark): `scripts/e2e-gate.sh 0B43D716-9670-421A-BE51-9162004F2963 --only 99-sheet-spike`
(run ids `1795428782840`, `1795428943689`, `1795429478700`). Evidence comes from the screenshots
plus the on-screen probes (`dismissed N`, `detent N`, `gestureCancel N`, `published counter N`).
Optional Maestro asserts were read in the run's `maestro.log`. The patch is in
`.tentacle/tmp/mobile-native-sheets/spike.patch` and was reverted with `git apply -R`. Shots:
`docs/feat/mobile-native-sheets/spike/`.

| # | Result | What was seen | Shots |
|---|---|---|---|
| F0 (found) | — | **RNS resizes a formSheet's ScrollView to the whole sheet** (`RNSScreenContentWrapper.mm:145-177`, `RNSScreen.mm:202-237`). It does this unless the route root's DIRECT children are `[header View collapsable={false}, ScrollView]` (at most 2). The first run used one wrapping `View`, so the list was drawn OVER the head, and the head's buttons were untappable (Maestro's tap on `pop self` hit a row). Run 2 used the two-child shape and laid out correctly. | `F0-scrollview-overlaps-head` |
| F1 | **PASS** | Opens at the middle detent (the sheet's top at ~52 % of the screen). The background is dimmed and the grabber is drawn. The published counter keeps ticking inside the route (3 → 22 s apart). Drag → `detent 2` (large), drag down → `detent 0` (small). `sheetDetentChange` fires on drags only: the probe reads `-1` until the first drag (nothing on the initial presentation, nothing on a keyboard-driven move). | `F1-a-medium`, `F1-b-large`, `F1-c-small` |
| F2 | **PASS** | A native swipe-down from small removes the route. The `state` listener in `SessionScreen` counted exactly one removal (`dismissed 1`), and `spike-sheet-1` is gone. | `F2-dismissed` |
| F3 | **PASS** | `gestureEnabled:false`: a hard swipe-down only moves the sheet to small, and `gestureCancel 1` arrives. A backdrop tap does nothing. Dragging small → large still works (`detent 2`). A keyed `pop` of its own key then closes it (`dismissed 2`). | `F3-a-after-swipe-down`, `F3-b-after-backdrop-tap`, `F3-c-dragged-large`, `F3-d-popped` |
| F4 | **PASS** (top-pop) · lower recorded | A push while one sheet is up stacks a second sheet (`depth 2`). A keyed pop of the TOP removes only it (`depth 1` stays, `dismissed 3`). **A keyed pop of the LOWER sheet removes BOTH routes** (`dismissed` 3 → 5 at once, empty screen at 0 s and at 1.5 s). There was no re-present: the upper route is lost from state as well, not just flashed. | `F4-a-stacked`, `F4-b-top-popped`, `F4-c-lower-pop-0s` |
| F5 | **(a) FAIL** · (b) recorded | (a) Sheet up, lock `immediately`, Home, relaunch: **`lock-screen` never appears** (optional assert WARNED after 15 s). The Face ID prompt shows over the LIVE session and sheet, so their content is visible while locked. After the match the sheet is still there, ticking. (b) No sheet up → lock → a push fires while locked (5 s timer): the cover stays on top (no sheet over it). After unlock the sheet is up, so the push landed under the cover or after it. | `F5-a-locked-over-sheet`, `F5-a2-unlocked`, `F5-b-push-while-locked`, `F5-b2-unlocked` |
| F6 | recorded — **both wedge the navigator** | (a) RN `Modal` up → push: the Modal is dismissed natively and the sheet shows. React still holds `visible:true`. After that sheet is popped, the next push presents **nothing** (`spike-sheet-1` assert fails, run 2). (b) Sheet up → open an RN `Modal` from `SessionScreen`: it never shows, not even after the sheet is popped. The next push also presents nothing (run 3, `F6-b3`). In both cases the stale `visible` Modal blocks every later formSheet. | `F6-a-modal-then-push`, `F6-a2-push-after-wedged`, `F6-b-sheet-then-modal`, `F6-b2-after-sheet-pop`, `F6-b3-push-after` |
| F7 | recorded (pre-existing bug, likely) | Current code: Tools open, then the laptop raises an `EDIT` ask on the session (`laptop-prompt` hook). `perm-sheet` never shows while Tools is up (WARNED, 8 s), **nor after Tools is swiped away** (WARNED, 5 s). The row shows `Write spike.txt` running. Caveat: the ask was raised by the laptop on a fresh session, and the phone receiving it was not separately proven (flow 09 proves the same hook for a seeded session). | `F7-a-tools-then-ask`, `F7-b-after-tools-closed` |
| F8 | **PASS** (single) · nested recorded | With the head fixed and ONE ScrollView, an upward drag on the list expands medium → large (`detent 2`). With nested ScrollViews (outer + inner), the same drag scrolls the inner list (rows 15–21) and the sheet stays at medium. | `F8-a-single-scroll-up`, `F8-b-nested-scroll-up` |
| F9 | **PASS** | `TextInput` focused in a 0.5 sheet: UIKit moves the sheet to full height above the keyboard. The field (`hello`) and the button under it stay visible. | `F9-keyboard` |

Verdict: F1 and F2 pass, so the route approach (D1/D2) works. **F5a fails**, so the
load-bearing assumption's second half ("the lock cover still goes above it") is false as
built. The RN-`Modal` lock cannot present while the root VC is presenting a native sheet.

Plan impact (no plan text rewritten here; for the planner/owner):
- **Lock vs sheet (blocking, F5a).** The cover must win over any sheet. Candidate: make
  `reconcile` drain the stack while `locked` (pop the top until it is empty; `desired` survives,
  so the same sheets re-push after the unlock), and also pre-empt on `inactive`, before the
  app-switcher snapshot. Alternative: present the lock from the top-most VC or its own
  `UIWindow` (native work). Either one needs its own simulator proof, including the snapshot,
  before S3. Also re-check `docs/feat/mobile-lock.md` fact 3: it does not hold for this route.
- **Never pop a lower sheet (F4).** This is not cosmetic: it deletes the upper route too, and
  `dismissedNatively` would then report the upper sheet as swiped away and run its close
  handler (e.g. Outbox "Not now", or the permission sheet's `dismiss()`). `reconcile`'s
  top-only rule is mandatory. `dismissedNatively` must ignore keys removed by a planned pop of
  a sheet below them.
- **Foreign RN Modals must be fully gone before a push, and none may open while a sheet is up
  (F6).** `yieldForeign` has to close the Modal AND wait for its dismissal (`onDismiss`) before
  `push`. It must also stop new RN Modals while `actual.length > 0`, because a stale `visible`
  Modal wedges all later sheets. Rename (an RN Modal) after Commands therefore has to wait
  for `transitionEnd {closing:true}`, and Info → Artifacts the same way.
- **Sheet layout shape (F0).** `NativeSheetRoute` / `Sheet native` must render exactly two
  direct children: a `collapsable={false}` head and ONE `ScrollView`. Any wrapper `View`
  breaks the layout. D4's "pinned head + one inner scroller" is required, not optional.
- **Detent probe (F1).** `sheetDetentChange` does not fire on the initial presentation or on
  keyboard moves. Nothing in the plan depends on it today; keep it that way.
- **F7 baseline.** Likely a pre-existing bug, removed by construction once Permission is the
  top route (D3 `desiredStack`). Add an e2e assertion for it in S5.

### Step 0b — lock drain (A) results

*— claude-opus-5-5, 2026-11-23*

How it ran: a throwaway patch on top of Step 0's harness. `src/sheet-spike.tsx` held a module
registry with a desired stack `{id, held, detent}`. A reconcile effect in `SessionScreen` drained
the stack whenever `locked || AppState !== "active"`, popping every sheet top-down with keyed
pops. Otherwise it pushed the first missing entry with `sheetInitialDetentIndex = entry.detent`,
and `sheetDetentChange` (stable) updated `entry.detent`. A `state` listener treated an unplanned
removal as a swipe and dropped that entry. The REAL `PermissionSheetView` was rendered
without its `Modal` (a `native` prop) inside a held (`gestureEnabled:false`) route. An on-screen
event log (`inactive@t pop:x push:x/dN perm:true|false …`) went in every sheet head. `App.tsx`
fed `lockView.locked` in through an effect. Flow `99-sheet-spike`: session `ASK4`, lock
`immediately`, user sheet dragged to L, a laptop `EDIT` ask on top dragged to L, then L1–L5.
Five gate runs on `0B43D716…` (iOS 26, dark). Runs 1–4 found the flow mechanics below; **run 5
`1795436513826` = GATE PASS**. The patch is in `.tentacle/tmp/mobile-native-sheets/spike-lock.patch`,
reverted with `git apply -R`. Shots: `docs/feat/mobile-native-sheets/spike-lock/`.

| # | Result | What was seen | Shots |
|---|---|---|---|
| L1 | **PASS** | Two sheets up (user at L, ask at L) → Home → relaunch: Maestro's `lock-screen` assert **passes** (151 ms; it WARNED in Step 0 F5a). The shot shows only the lock cover, with no sheet and no session content. Log: `inactive@44360 pop:user@44366 background@45424`. The drain runs ~6 ms after `inactive`, about 1 s before `background`, so the lock's `Modal` presents on a root that has stopped presenting. | `L1-a-relaunch-locked` |
| L2 | **NOT PROVEN** | The switcher could not be opened on the simulator. Maestro has no app-switcher command. A bottom-edge swipe-and-hold only drags the sheet (`L2-x-edge-swipe-no-switcher`), and `osascript` (Simulator ⌃⇧⌘H) was not approved in this session. Indirect evidence: (a) the stack is empty ~1 s before `background` (L1 log); (b) the relaunch card iOS animates from shows the lock only (`L1-a`); (c) the native expo blur is on for `immediately` anyway (`switcher-cover.ts`). This is the same gap as `docs/feat/mobile-lock.md` 0.4. **Retry after the owner's OK (2026-11-23):** `osascript` cannot address Simulator.app from this agent's shell. `tell application "Simulator"`, `application id "com.apple.iphonesimulator"` and the full `…/Xcode.app/Contents/Developer/Applications/Simulator.app` path all fail with `-1728 Can't get application`, also with the command sandbox off. The simulator itself is booted (`simctl boot` → "current state: Booted"). Likely cause: no LaunchServices/GUI session reachable from this process; not confirmed, because `launchctl managername` needed an approval that was not given. The patch was not re-applied, because the flow could not have reached the switcher. | `L2-x-edge-swipe-no-switcher` |
| L3 | **PASS** (user sheet) · ask detent reset, explained | After unlock: `push:user/d2 push:perm/d2`, so both re-pushed at their remembered detent, with the same content (the published counter is live in the re-pushed route: 39 in `L3-a`). The ask then **re-opens at M**. The log shows why: `perm:false@20528 pop:perm perm:true@20599 push:perm/d1`. On resume the link re-delivers the ask, so `state.sheet` goes `idle → asking` for ~70 ms, the entry is dropped and then re-created at the spec's detent. That is not the drain; it happens on every resume. | `L0-c-ask-large`, `L4-run4-ask-back-log`, `L3-a-user-back-large` |
| L4 | **PASS** | The same ask (`Write a file · project/spike.txt`) is back after unlock with live options, unanswered. The drain's pops are planned, so `swiped 0` and nothing ran `sheet.dismiss()`. Tapping *Allow once* closes it, and the user sheet below stays at L. | `L4-a-ask-back`, `L4-b-ask-at-m`, `L3-a-user-back-large` |
| L5 | **PASS** | Three Home/relaunch/Face ID cycles with no waits (`drains 6`): the user sheet re-pushes at `d2` each time. Afterwards a native swipe closes it (`swiped:user`, `desired none`), and `spike-open` pushes a fresh one at M. The navigator does not wedge. | `L5-a-after-rapid`, `L5-b-swiped`, `L5-c-reopened` |

Found on the way (plan impact):
- **`lockView.locked` read in `App.tsx` is stale.** The log never showed a `LOCKED`/`unlocked`
  edge: `AppShell` reads `lockInstance.view()` at render, and `LockGate` owns the re-render
  (`App.tsx:2379`, no subscription). Every drain in this spike came from the `AppState` leg.
  The `locked` input must come from the lock itself (a `subscribe` on the instance, or
  `LockGate` publishing it), not from `AppShell`'s render.
- **`inactive` is the load-bearing trigger, not `background` or `locked`.** In L1/L3, JS saw
  `inactive`, then nothing until `active` (iOS suspends JS; `background` was not always
  delivered before the resume). `active` with the lock still up is then gated only by `locked`,
  so the stale value above matters. Here the pushes landed under the cover and the cover stayed
  on top (L1 assert, consistent with F5b), but the design must not rely on that.
- **The ask flickers on resume** (`idle → asking`). The desired entry for Permission must not
  be keyed on "an ask is pending". It must be keyed on the ask's identity (request id/seq), with
  the detent remembered per identity, so a re-delivery of the SAME ask re-opens at its last
  detent and does not pop and re-push.
- **Two stacked formSheets hide the whole app from XCUITest.** With the ask over a user sheet,
  the hierarchy dump holds only the status bar (runs 1–2: `perm-sheet`, `spike-sheet-perm`,
  "Write a file" all not found, although on screen). S6 flows that assert inside a stacked sheet
  must tap by point or close the lower sheet first. Whether a SINGLE sheet's inner `perm-sheet`
  id is visible was not isolated here: re-check it in S5.

Verdict: the drain (A) works for L1, L3, L4 and L5. **L2 cannot be proven on this simulator
without one approval** (osascript → Simulator "App Switcher", then a screenshot) or a real
device.

### S1 — `sheet-plan.ts` + tests

*— claude-opus-5-5 (executor), 2026-11-23*

**Load-bearing check first (reproduced).** `.tentacle/tmp/mobile-native-sheets/s1-baseline.log`:
`apps/mobile/src/sheet-plan.ts` and `apps/mobile/test/sheet-plan.test.ts` do not exist; grep for
`sheetAllowedDetents|sheetInitialDetentIndex|sheetDetentChange` over `apps/mobile/src` and
`App.tsx` → **no hit** (no detent option is used anywhere yet); grep for
`SHEET_SPEC|desiredStack|dismissedNatively` → no hit. So the capability is genuinely missing:
nothing in the app decides a detent or a sheet stack today.

**As built** (only S1; no other slice touched):

- `apps/mobile/src/sheet-plan.ts` (new, 431 lines, pure and React-free — the
  `activity-panel.ts`/`reveal-report.ts` pattern): `SheetKind`/`SHEET_KINDS`, `SHEET_SPEC`
  (0.3/0.5/1.0 ascending, initial 1, dimmed -1, grabber on, for all five — Owner Q1),
  `clampDetent`, `initialDetent` (spec index; +1 step at `DENSE_FONT_SCALE`; largest for
  `info` + reveal), `sheetOptions` (the NS option object: `presentation:"formSheet"`,
  `headerShown:false`, `sheetExpandsWhenScrolledToEdge:true`, `gestureEnabled` per
  `sheetGestureEnabled`), `sheetGestureEnabled` (false only for permission + asking, D5),
  `sheetGround` (`bg` / `sheet`), `desiredStack`, `reconcile`, `dismissedNatively`,
  `DetentMemory` (`createDetentMemory`/`rememberDetent`/`rememberedDetent`/`openingDetent`,
  identity-keyed, bounded at `DETENT_MEMORY_MAX = 16`, oldest-out), `INTENT_SHEET`/
  `queueAfterDismiss`/`readyIntents`, `yieldForeign`, `sessionInFront`, `sheetHidden`.
- `apps/mobile/test/sheet-plan.test.ts` (new, 479 lines, 53 tests): every item the plan's *Tests* list
  names for S1, plus `sheetOptions` acceptance, `clampDetent`, the memory's bound and eviction,
  `readyIntents`, `sheetHidden` and `sheetGround`.
- `changelog.d/mobile-native-sheets.changed.md` (the fragment the Implementation names).

**Red before green.** The test file was written first; on the missing module it fails
(`error: Cannot find module '../src/sheet-plan.ts' … 0 pass 1 fail`) — a compile-level red, so
the mutation checks below carry the burden of proving each assertion holds (AGENTS §9).

**Mutation checks** (`.tentacle/tmp/mobile-native-sheets/mutate-s1.sh`; each mutation applied
to `src/sheet-plan.ts`, the narrow test file run, the file restored from a scratch copy — never
`git checkout`; the restored source is byte-identical to the pre-mutation copy):

| # | Mutation | Result |
|---|---|---|
| M1 | `DETENTS = [0.5, 0.3, 1.0]` (unsorted) | 46 pass **7 fail** |
| M2 | `reconcile` pops `actual[i]` (a lower key) instead of the top | 50 **3 fail** |
| M3 | `dismissedNatively` ignores `plannedPop` | 50 **3 fail** |
| M4 | `reconcile` pushes while `hidden` | 52 **1 fail** |
| M5 | the drain waits for `transitioning` | 52 **1 fail** |
| M6 | `initialDetent` ignores `reveal` | 51 **2 fail** |
| M7 | `initialDetent` ignores `DENSE_FONT_SCALE` | 51 **2 fail** |
| M8 | `sheetGestureEnabled` held for every asking sheet | 51 **2 fail** |
| M9 | `sessionInFront` drops the sheet leg | 52 **1 fail** |
| M10 | `sheetHidden` drops the `inactive` leg | 52 **1 fail** |
| M11 | detent memory keyed on the kind, not the identity | 51 **2 fail** |
| M12 | `readyIntents` runs with a sheet still up | 52 **1 fail** |
| M13 | `yieldForeign` ignores the about-to-push leg | 52 **1 fail** |
| M14 | `desiredStack` puts the ask below the user sheet | 51 **2 fail** |

All 14 mutations go red, and the restored file is 53/53 green (316 `expect()` calls).

**Drift from the Implementation — two, both small and inside S1:**

1. `sheetGround(kind)` returns the literal union `SheetGround = "bg" | "sheet"` instead of
   `keyof Palette`. Same values, but `keyof Palette` would make the module import a type it never
   uses at runtime and type the return wider than the two tokens the plan names. The route (S2)
   reads `palette[sheetGround(kind)]`, which still typechecks.
2. `reconcile` takes the plan's two gate flags as ONE `ReconcileGate` object (`{hidden,
   transitioning}`), and `readyIntents` takes `{transitioning, closingDone?}` — the plan states
   the rules, not the signatures. `closingDone` is the plan's `transitionEnd {closing:true}`
   leg, made explicit.

`DETENT_MEMORY_MAX = 16` is not in the plan; the plan asks for a "bounded" store without a
number, so the bound is chosen here (an ask's id is used for at most a few resumes).

**Verified.** `bun test apps/mobile/test/sheet-plan.test.ts` → 53 pass / 0 fail ·
`bun test` on the neighbours the plan names (`permission-sheet`, `commands-sheet`,
`tools-view`, `session-info`) → 129 pass / 0 fail · the source-scanning guard suites a new `src`
module can trip (`bundle-node-free`, `node-builtins-guard`, `motion-literals`, `text-seam`,
`theme`, `band-screens`, `pairing-guards`, `app-config`, `header-wiring`) → 245 pass / 0 fail ·
`bun test scripts/test/changelog-guard.test.ts scripts/test/changelog.test.ts` → 21 pass ·
`bunx tsc -p apps/mobile` clean · `bunx biome check` on the three changed files clean. The full
`bun run check` gate is the orchestrator's.

**Not done, by instruction:** S2–S6 (the route, the host bridge, the screen wiring, the sheet
components' migration, e2e). Nothing outside S1's file list was touched; `TODO.md` untouched.

### S2 — `sheet-host.ts`, the route type, `NativeSheetRoute`, the `App.tsx` screen

*— claude-opus-5-5 (executor), 2026-11-23*

**Load-bearing check first (re-run, reproduced).** `.tentacle/tmp/mobile-native-sheets/s2-baseline.log`:
`apps/mobile/src/sheet-host.ts`, `apps/mobile/test/sheet-host.test.ts` and
`apps/mobile/test/native-sheets-wiring.test.ts` do not exist; `grep -rn 'sheet-host|NativeSheetRoute|name="Sheet"|SheetKind'`
over `apps/mobile/src apps/mobile/App.tsx apps/mobile/test` hits **only** `sheet-plan.test.ts`/`sheet-plan.ts`
(S1's own union) — no route, no `Sheet` screen, no bridge. So the capability S2 adds is genuinely
missing: after S1 there is still no way for a sheet's content to reach a route.

**Red first (AGENTS §9), both files, on the S1 tree:**
- `bun test apps/mobile/test/sheet-host.test.ts` → `Cannot find module '../src/sheet-host.ts'` — 0 pass, 1 fail (`red-s2-host.log`).
- `bun test apps/mobile/test/native-sheets-wiring.test.ts` → 5 pass / 5 fail, every `Sheet`-screen and
  route assertion red on `indexOf` = −1 (`red-s2-wiring.log`); the 5 that passed are the assertions S1
  already satisfies (the kind union, `SHEET_KINDS`).

**As built (dependency order, the plan's File 2→5).**
1. `apps/mobile/src/sheet-host.ts` — the `artifact-feed.ts` shape: `SHEET_HOSTS` (one registry for the
   app), one `SheetHost` per `computerId`/`sessionId`, `publish(kind, content)` / `current` / `subscribe`
   / `forget` / `orphaned`, plus the route's ONE branch `sheetRouteView(snapshot)` → `draw | wait | pop`.
2. `apps/mobile/src/routes.ts` — `SheetRouteParam` + `Sheet: SheetRouteParam` in `RootStackParams`, and
   `SheetKind` re-exported from `sheet-plan.ts` so the route table and `sheetOptions` cannot disagree.
3. `apps/mobile/src/screens/NativeSheetRoute.tsx` — render only: `SHEET_HOSTS.host(...)`,
   `useSyncExternalStore`, `sheetRouteView`, `null` for anything but `draw`, the keyed `onClose` handed
   in by the navigator.
4. `apps/mobile/App.tsx` — ONE `<Stack.Screen name="Sheet">`, options
   `{...sheetOptions(route.params.kind, { fontScale: PixelRatio.getFontScale() })`, `contentStyle:
   { backgroundColor: palette[sheetGround(route.params.kind)] }}`, `onClose={() => navigation.pop()}`
   (the screen's own `navigation` dispatches with `source: route.key`, so the pop is keyed —
   `StackRouter` `POP` at `routers/src/StackRouter.tsx:557-581`).
5. Changelog: `changelog.d/mobile-native-sheets.changed.md` **already exists** (S1, the feature-level
   bullet). S2 adds no user-visible change on its own — nothing pushes the route yet — so no second
   fragment was written rather than duplicating the user-facing claim.

**Drift from the Implementation — two, both small and inside S2's files:**

1. **The snapshot is an object, not `host.current(kind)`.** D2 sketches
   `useSyncExternalStore(host.subscribe, () => host.current(kind))`. That cannot express the orphan leg:
   `current` is `undefined` both for "nothing published yet" (WAIT — a push and the publishing layout
   effect are not ordered across two screens) and for "the screen is gone" (POP). So the host exposes
   `snapshot(kind): { content, orphaned }`, **memoized per kind** and returned with a stable identity
   until that kind's content or the orphan flag changes (React's `getSnapshot` contract: a fresh object
   per call re-renders forever). `sync/store` test + mutation M3 pin it.
2. **`sheetOptions` is called with `fontScale` only.** S1's signature accepts `asking` (D5's
   `gestureEnabled`), but S2 has no permission route and no ask state on the navigator — `asking` is
   S3/S5's to pass. The `perm-hold`/`perm-later` behaviour is therefore **not** landed here.

Also chosen here, not in the plan: the host key separator is `\u0000` (`sheetHostKey`), so two sessions
whose ids would collide in a plain `c1/s1` join stay apart (mutation M4).

**Mutation checks (`sheet-host.test.ts` + `native-sheets-wiring.test.ts`, single-file mutations, restored
byte-identical, script `.tentacle/tmp/mobile-native-sheets/mutate-s2.sh`):**

| # | Mutation | Result |
|---|---|---|
| — | baseline | 11 pass / 10 pass, 0 fail |
| M1 | `sheetRouteView` drops the orphan leg (a forgotten host keeps drawing) | 10 pass **1 fail** |
| M2 | nothing published → `pop` instead of `wait` | 10 pass **1 fail** |
| M3 | `snapshot` returns a fresh object every call | 10 pass **1 fail** |
| M4 | `sheetHostKey` is a plain `${a}/${b}` join | 10 pass **1 fail** |
| M5 | `forget` keeps the published content | 10 pass **1 fail** |
| M6 | the navigator restates `presentation: "formSheet"` | 9 pass **1 fail** |
| M7 | the sheet closes with an unkeyed `goBack()` | 9 pass **1 fail** |
| M8 | the route reads another session's host | 9 pass **1 fail** |
| M9 | the route decides locally instead of `sheetRouteView` | 9 pass **1 fail** |
| — | restored | `identical` for all three files, 11 pass / 10 pass, 0 fail |

**Verified.** `bun test` on `sheet-host`, `native-sheets-wiring`, `sheet-plan`, `routes`,
`bundle-node-free` → 82 pass / 0 fail · every suite that reads `App.tsx` (31 files) → 459 pass / 0 fail ·
the source-scanning guards a new `src` module or a new screen can trip (`text-seam`, `motion-literals`,
`node-builtins-guard`, `theme`, `band-screens`, `app-config`, `drawer-nav`, `hub-artifacts-wiring`) →
226 pass / 0 fail · `bun test scripts/test/changelog-guard.test.ts scripts/test/changelog.test.ts` → 21
pass · `bunx tsc -p apps/mobile` clean · `bunx biome check` on the six changed files clean. No schema
change, so `protocol.json` is untouched. The full `bun run check` gate is the orchestrator's.

**Not done, by instruction:** S3–S6 — nothing pushes `Sheet` yet, `SessionScreen` does not publish to
`SHEET_HOSTS` (so the route would `wait` forever if pushed), the five components keep their `<Modal>`,
and no e2e/Validation run. `TODO.md` untouched.

### Gate fix after exec — the root program's ambient timers (2026-11-23)

*— deepseek-v4-pro, gate repair on `feat/mobile-native-sheets`*

**Symptom (orchestrator's gate, `tsc --noEmit`, 7 errors in 6 files):** every
`setInterval(...)` / `setTimeout(...)` handle in `cli`, `exec`, `docker`, `k8s` and `daemon` was typed
`number`, so `timer.unref()` did not exist:

```
packages/cli/src/shared-auto-accept.ts(45,9): error TS2339: Property 'unref' does not exist on type 'number'.
packages/cli/src/status-line.ts(155,16): …  packages/daemon/src/session-reaper.ts(186,14)…(204,16)
packages/docker/src/ssh-dialer.ts(311,76): …  packages/exec/src/host-execution.ts(441,72): …
packages/exec/src/process-group.ts(182,16): …  packages/k8s/src/exec-run.ts(220,22): …
```

**Root cause — one new type-only import leaked a `declare global` into the ROOT program.**
`apps/mobile/src/sheet-plan.ts:25` imported `type { NativeStackNavigationOptions } from
"@react-navigation/native-stack"`. That package pulls `react-native`, whose
`src/types/globals.d.ts` (`// #region Timer Functions`) `declare global`s
`function setInterval(handler: () => void, timeout: number): number` and the same for `setTimeout`.
Type-only does not mean type-*erasable*: the file still joins the program that resolves its
declarations, so the ambient override of the Bun timers applied to the whole monorepo.

The reach into the ROOT `tsc --noEmit` (not just `tsc -p apps/mobile`) is
`scripts/mockup-kit/sources.ts` → `apps/mobile/src/drawer-nav.ts` → `routes.ts` → `sheet-plan.ts`. The
new `import type { SheetKind }` in `routes.ts` is what first made that chain pull `sheet-plan.ts` into
the root program (`scripts/**` is in the root `include`). `apps/mobile`'s own program was never
affected — `tsc -p apps/mobile` is clean on `main` and on this branch.

**Evidence (decisive, one probe).** `tsc --noEmit --listFiles`: `react-native/types_generated/index.d.ts`
in the program → **0 files on `main`, 1 on this branch**. A focused tsconfig including only
`packages/exec/src/process-group.ts` typechecks clean; adding `apps/mobile/src/sheet-plan.ts` alone
reproduces it. `--explainFiles` names the chain above.

**Fix — declare the option subset locally instead of importing the navigation type.** `sheet-plan.ts`
gains `export interface SheetNavigationOptions` (the eight fields the table actually decides:
`headerShown`, `presentation`, `sheetAllowedDetents`, `sheetInitialDetentIndex`,
`sheetLargestUndimmedDetentIndex`, `sheetGrabberVisible`, `sheetExpandsWhenScrolledToEdge`,
`gestureEnabled`), and `sheetOptions` returns it. `App.tsx` still spreads it into `Stack.Screen` under
`tsc -p apps/mobile`, where the object is checked against the real `NativeStackNavigationOptions` — that
assignment is the acceptance test, so an RNS rename is caught, not silently accepted. This keeps the
pure module React-free (AGENTS §7) as the doc already required; the plan's §D3 wording ("the NS option
object") is unchanged in spirit — the object is still built from the table.

No cast, no `as`, and **no edit to the seven consuming packages**: the fixed property is "the root
program keeps Bun's timer types", not "silence seven errors".

**Regression test (non-vacuous).** A new source guard in `native-sheets-wiring.test.ts` ("the pure
module stays OUT of react-native's types") asserts `sheet-plan.ts` imports neither `react-native` nor
`@react-navigation/*` and still exports `SheetNavigationOptions`. Mutation: re-adding the
`import type { NativeStackNavigationOptions }` line makes it **fail** (1 fail / 10 pass) and the root
`tsc` red with the same 7 errors; restoring it gives 11 pass / 0 fail and a clean gate.

**Verified after the fix.** `tsc --noEmit` → clean, 0 react-native type files in program ·
`tsc -p apps/mobile` → clean · `tsc -p apps/relay` → clean ·
`bun test` on `sheet-plan`, `sheet-host`, `native-sheets-wiring`, `permission-sheet`,
`workflow-approve-sheet` → 105 pass / 0 fail · `bunx biome check` on both changed files → clean.
The full `bun run check` gate remains the orchestrator's.

### S3 — reconcile loop, native-dismiss sync, lock drain, yield, `sessionInFront`; Commands + Outbox

*— deepseek-v4-pro (first pass, stopped by the watchdog at 253 tool calls) + claude-opus-5-5 (resume: review of the partial tree, fixes, wiring, mutations), 2026-11-23*

**Load-bearing check (re-run, reproduced)** — `.tentacle/tmp/mobile-native-sheets/s3-baseline.log`:
`SessionScreen` neither publishes to `SHEET_HOSTS` nor pushes `Sheet` nor reconciles (no hit); `createAppLock`
had `state/dispatch/view` only (no subscription); `AppShell` read `lockInstance.view()` at render (the stale
leg, Step 0b); Commands and Outbox still drew a `<Modal>`. So the capability S3 adds was missing.

**As built (dependency order).**
1. `src/app-lock.ts` — `AppLock.subscribe(listener)`: every `dispatch` notifies with the NEW view; per-instance
   listener set (the drain's `locked` source, Step 0b; never `AppShell`'s render-time `lockView`).
2. `src/sheet-plan.ts` (additions, still React-free) — `SHEET_ROUTE`, `sheetEntriesOf` (the `Sheet` routes,
   unknown kinds ignored), `drainPops` (every key, top-down, one pass), `managedStack` +
   `PRESENTED_SHEET_KINDS = ["commands","outbox"]` (a kind still drawn by its own Modal is never pushed),
   `sameStack`, `stackSignature` (a string, so `useNavigationState` does not re-render forever),
   `sheetsOfSession` (two Session screens share one root stack), `appActivity` (`null`/`unknown` ⇒ hidden),
   `SHEET_DETENTS` (the app's one detent memory), `sheetDetentContext`, `sheetIdentity` (ask id for
   Permission, the kind otherwise), `recordDetent` (stable changes only).
3. `src/routes.ts` — `SheetStackNavigation`, `openSheet` (`push`, never `navigate`), `popSheet` (a `POP` keyed
   on `source`, targeted at the stack; no react-navigation import).
4. `App.tsx` — `AppShell` mirrors `lockInstance.subscribe` into `sheetLocked` → `SessionRoute` → `SessionScreen`
   (`locked`, `computerId`, `sessionId`); the `Sheet` screen opens at `sheetDetentContext(...)` (remembered
   detent + font scale) and records `sheetDetentChange` through `recordDetent`.
5. `CommandsSheet.tsx`, `compose/OutboxDecisionSheet.tsx` — `<Modal>` and `visible` removed (render only).
6. `SessionScreen.tsx` — publishes both elements in a layout effect, `forget` on unmount; `desiredStack` →
   `managedStack`; one effect = drain (`sheetHidden(locked, appActivity(AppState))`, every key in one pass,
   all marked planned) else ONE `reconcile` step (pop keyed / push only while `inFront`); `dismissedNatively`
   runs the swiped kind's own close (`setCommandsOpen(false)`, `setDeciding(null)`); Commands → Rename goes
   through `queueAfterDismiss`/`readyIntents`; `yieldForeign` hides the hub/session `ActionSheet`s, `ActivitySheet`
   and `RenameSheet` (its text stays in the controller); voice gates read `sessionInFront(focused, sheetStack)`.

**Fixed on resume (the partial tree had them wrong; each now pinned by a wiring test, see mutations):**
- `owner` was a fresh object per render and the `forget` effect depended on it → the host was forgotten on
  EVERY render (the route could read `orphaned` and pop itself). Now `useMemo([computerId, sessionId])`.
- The push was gated on raw `useIsFocused()`; this session's own sheet blurs Session, so an Outbox decision
  arriving while Commands is up would never be pushed. Now gated on `inFront` (`sessionInFront`).
- `plannedPop` was reset to `[]` on every stack change; a drain whose pops land over more than one navigator
  state would report the later ones as swipes (running Outbox "Not now"). Now only landed keys are spent.
- `afterDismiss` was declared but never fed (Rename began under the sheet, only hidden by `yields`). Now
  `renameFromCommands` queues `"rename"` and `controller.beginRename()` runs once the route is gone.
- The detent memory functions existed but nothing called them; wired in `App.tsx` (above).
- The wanted stack is memoized on its content (`wantedKey`) so the loop does not re-run on every render.
- A wiring assertion `not.toContain('"tools"')` was vacuous-by-accident (red on unrelated `"tools"` strings);
  replaced.

**Drift from the Implementation.**
1. `afterDismiss` readiness = the route has LEFT the navigation state (`readyIntents` with `actual` empty), not
   `transitionEnd {closing:true}`: a popped route is unmounted, so its own `transitionEnd` listener is gone
   (`NativeStackView.native.tsx:114-120` emits it on the route). **Unverified:** whether an RN Modal (Rename)
   presents cleanly during the native dismiss animation — check in S6 (Commands → Rename on the simulator).
2. Detent identity is wired as `sheetIdentity(kind, null)` — correct for the two S3 kinds (keyed on the kind).
   The ask id joins the route params when Permission becomes a route (S5); the pure identity rule and its
   re-delivery test land here.
3. `PRESENTED_SHEET_KINDS` (not in the plan): with three sheets still on RN Modals, pushing their kinds would
   draw an empty route over a modal sheet. S4/S5 extend the list.
4. Commands/Outbox render through today's `Sheet` (not the `native` variant, S4): the F0 two-child layout and
   the single-scroller expand are S4's; until then their in-sheet scrolling is unverified on device.

**Tests.** `sheet-plan.test.ts` (+S3 blocks: `sheetEntriesOf`, `drainPops`, `sheetIdentity` incl. "a re-delivered
ask keeps its detent" (L3), `recordDetent`, `managedStack`/`stackSignature`, `appActivity`, `sheetsOfSession`),
`app-lock.test.ts` (subscription: every view, the `loaded` leg, unsubscribe, per-instance list),
`native-sheets-wiring.test.ts` (S3 block: 16 source-structure tests), `commands-sheet.test.ts`/`row-a11y.test.ts`
(no `visible`; Rename queued).

**Mutation checks.** DeepSeek's (`.tentacle/tmp/mobile-native-sheets/mutations-s3.log`): M1 `drainPops`
bottom-up → 1 fail · M2 `sheetIdentity` drops the ask id → 2 fail (incl. L3 re-delivery) · M3 `recordDetent`
keeps mid-drag → 1 fail · M4 `sheetEntriesOf` keeps non-`Sheet` routes → 0 fail at first, a name-masking test
added → 1 fail · M5 unknown kind guessed → 1 fail · M6 lock never notifies → 3 fail · M7 module-global listener
list → 0 fail at first, an instance-isolation test added → 1 fail · M8 `managedStack` pushes every kind → 1
fail · M9 signature counts routes → 1 fail; each restored green. Resume (wiring + commands tests, applied by
hand and reverted):

| # | Mutation | Result |
|---|---|---|
| R1 | `owner` not memoized | 43 pass **1 fail** |
| R2 | push gated on raw `focused` | **fail** (`inFront` test) |
| R3 | `plannedPop.current = []` | **fail** (landed-pops test) |
| R4 | Rename `beginRename()` under the sheet | **2 fail** (wiring + commands-sheet) |
| R5 | `sheetDetentChange` listener renamed | **fail** (detent-memory test) |
| — | R2–R5 applied together | 39 pass **5 fail**, each its own named test; restored → 44 pass |

**Verified.** S3 files (`native-sheets-wiring`, `sheet-plan`, `app-lock`, `commands-sheet`, `row-a11y`,
`sheet-host`) → 169 pass / 0 fail · the 42 other suites that read `SessionScreen.tsx`/`App.tsx`/`app-lock`/the two
sheets, plus `bundle-node-free`, `theme`, `band-screens`, `routes` → 723 pass / 0 fail · `bunx tsc -p apps/mobile`
clean · `bunx biome check` on the 12 changed files clean. No schema change (`protocol.json` untouched). Changelog:
the S1 fragment `changelog.d/mobile-native-sheets.changed.md` already states the feature (incl. the drain and
remembered detents); no second fragment. The full gate is the orchestrator's. Not simulator-run (S6).

**Not done, by instruction:** S4 (Tools, Session info, `Sheet native`), S5 (Permission, D5), S6 (e2e + Validation).
`TODO.md` untouched.

### S4 — `Sheet native`, Tools and Session info

*— claude-opus-5-5 (executor), 2026-11-23*

**Load-bearing check first (re-run, reproduced)** — `.tentacle/tmp/mobile-native-sheets/s4-baseline.log`:
`ui/Sheet.tsx` has no `native` variant (only a doc-comment mentions "native"); `ToolsSheet.tsx:127-130`
and `SessionInfoSheet.tsx:366-369` still draw `<Modal visible presentationStyle="pageSheet">`;
`ui/Sheet.tsx`'s `scroll` variant still nests the list inside a second `ScrollView` at the call sites
(Tools/Info each pass their own); `PRESENTED_SHEET_KINDS` is still `["commands","outbox"]`, so nothing
pushes Tools or Info; `sheetDetentContext` ignores a reveal; `afterDismiss` is only ever fed `"rename"`.
So S4's capability was genuinely missing.

**Red first (AGENTS §9), on the S3 tree:** `bun test sheet-plan native-sheets-wiring` → **97 pass / 19 fail**
(`.tentacle/tmp/mobile-native-sheets/red-s4.log`), and every one of the 19 is red **on its assertion**
(no module resolution or import error): 7 for the native variant + the two-child shape, 5 for the
publish/one-scroller wiring, 3 for the reveal, 2 for the two swipes' closes, 1 for the queued Artifacts
intent, 1 for `PRESENTED_SHEET_KINDS`.

**As built (dependency order).**
1. `src/sheet-plan.ts` — `PRESENTED_SHEET_KINDS` grows to `["commands","outbox","tools","info"]`
   (`:304`); `sheetDetentContext` takes the reveal and states it on the context (`:376`) so the
   navigator can open Info at L.
2. `src/routes.ts:97` — `SheetRouteParam.reveal?`: the one fact a push carries beyond identity.
3. `src/ui/Sheet.tsx` — the `native` variant (`:86`, default false so `PairScreen` is unchanged): no
   drawn grabber (`:115`), no top radius (`:122-124`), and the **F0 shape** — exactly two direct children,
   a `collapsable={false}` head and ONE scroller (`:172-178`). The scroller now owns
   `keyboardShouldPersistTaps`, `scrollRef`, `scrollTestID` and `refreshControl`; its content carries
   `scrollContent: { gap: 0 }`, which is where Session info's old `styles.content` gap went (F8: one
   scroller, no nested pair).
4. `screens/ToolsSheet.tsx`, `screens/SessionInfoSheet.tsx` — `<Modal>`/`visible` removed; both are
   render-only, they hand their list to `Sheet`'s ONE scroller (`scroll native`) and add no
   `ScrollView` of their own. Tools keeps its `RefreshControl` and testIDs; Session info keeps
   `scrollRef` (the reveal's target) and its per-section `onLayout`.
5. `screens/SessionScreen.tsx` — both elements now published on `SHEET_HOSTS` (`:1269`, `:1291`) in the
   same layout effect as Commands/Outbox, instead of mounted in the JSX; a native swipe of either runs
   that kind's OWN close (`:1352`, `:1356`; both bodies are `useCallback`'d, shared with the glyph);
   `openArtifactsFromInfo` queues `"artifacts"` (`:1133`) so the gallery never opens under the sheet
   (F6b); the Info push states the reveal (`:1423`).
6. `App.tsx` — the `Sheet` screen's options pass `route.params.reveal === true` into
   `sheetDetentContext`.

**Drift from the Implementation — three, all inside S4:**

1. **`sheetDetentContext` carries the reveal as a 4th argument** rather than the design's
   `{fontScale, reveal}` being assembled in `App.tsx`. The reason is the one the plan already states for
   the detent memory: the route's options are resolved by the navigator *before* the route's screen
   mounts, so the fact has to ride the route's params — and having the screen read the reveal tracker
   (`reveal-report.ts`, a `useRef` in `SessionScreen`) from `App.tsx` would be a second source of truth.
   So the screen states it (`:1423`), the param carries it (`routes.ts:97`), and the decision stays in the
   pure module.
2. **The gap that kept Session info from doubling its section rhythm moved from its own
   `styles.content` to `Sheet`'s scroller** (`scrollContent`). With the inner `ScrollView` gone there is
   no place in the sheet for it, and leaving it out would have re-introduced the doubled `sectionTop`
   that `band-screens.test.ts` pins — that assertion now reads `ui/Sheet.tsx` and says why.
3. **`closeTools` / `closeInfoSheetOnly` are `useCallback`'d.** A `dismissedNatively` effect now depends
   on both, and an inline body would either re-run the effect every render or be an exhaustive-deps
   error (Biome caught it, `:1357`). Same bodies, stable identities. `closeToolsSheetOnly` is the alias
   the swipe path names, so Tools and Session info read the same way at the call site.

**Mutation checks (`.tentacle/tmp/mobile-native-sheets/mutate-s4.sh`; each applied to the real file, the
two narrow suites run, the file restored from a scratch copy — never `git checkout` — and `cmp`-verified
byte-identical: log `mutations-s4.log`).** Baseline 116 pass / 0 fail, restored 116 / 0 with all five
files `identical`.

| # | Mutation | Result |
|---|---|---|
| M1 | the native sheet draws its own grabber | 115 pass **1 fail** |
| M2 | the native sheet keeps the drawn corner radius | 115 **1 fail** |
| M3 | native keeps the wrapper `View` (F0 two-child shape lost) | 115 **1 fail** |
| M4 | the one scroller's `keyboardShouldPersistTaps` dropped | 115 **1 fail** |
| M5 | Tools back to the flat sheet (`scroll={false}`) | 115 **1 fail** |
| M6 | Session info not the native variant | 115 **1 fail** |
| M7 | the reveal's scroller loses its testID | 115 **1 fail** |
| M8 | the reveal is never stated on the push | 115 **1 fail** |
| M9 | a Tools swipe runs no close (controller goes stale) | 115 **1 fail** |
| M10 | a Session info swipe runs no close | 115 **1 fail** |
| M11 | Artifacts opens UNDER the sheet (F6b) | 115 **1 fail** |
| M12 | the S3 two-kind list comes back (tools/info never pushed) | 114 **2 fail** |
| M13 | the reveal's context leg dropped | 115 **1 fail** |
| M14 | Session info drops the scroll ref (the reveal scrolls nothing) | 115 **1 fail** |
| M15 | Tools loses its scroller testID | 115 **1 fail** |

Two findings from the first pass, both fixed before the table above: M5 and M12 initially **survived**
(M5 because nothing asserted why Tools asks for `scroll`; M12 because my mutation re-inserted the same
four kinds, i.e. it was not a mutation at all). M5 gained `expect(body).toMatch(/\n\s+scroll\n/)` plus the
`native` leg; M12 now restores the two-kind list. Both then went red.

**Verified.** `bun test` on the 50 test files that read the six changed sources or their call sites →
**751 pass / 0 fail**; `sheet-plan`/`native-sheets-wiring`/`sheet-host` → 127 pass; the source-scanning
guards (`bundle-node-free`, `node-builtins-guard`, `motion-literals`, `text-seam`, `theme`, `app-config`,
`drawer-nav`, `routes`) and the changelog guards → 217 pass / 0 fail; `bunx tsc -p apps/mobile` clean;
`bunx biome check` on `apps/mobile/src`, `apps/mobile/App.tsx`, `apps/mobile/test` → **0 errors, 0
warnings**. **One pre-existing failure class, NOT S4's:** two of these suites (`row-a11y`,
`session-info-schedules-render`, and the `band-notes` triple) raise `Export named 'ActivityIndicator' not
found` when run in the same process — their `mock.module("react-native")` bodies shadow each other. It
reproduces byte-for-byte with `HEAD`'s own copies of those test files (checked by restoring them to HEAD
in place and re-running, then restoring this slice's), and each file passes alone; the merge gate runs
the whole suite in its own process order, where they pass. No schema change, so
`packages/protocol/schema/protocol.json` is untouched. The changelog fragment written in S1 already
claims the feature; S4 adds no user-visible claim of its own, so no second fragment. The full `bun run
check` gate is the orchestrator's.

**Gate line (this slice, as run by me):** narrow suites green, `tsc -p apps/mobile` exit 0,
`biome check` 0/0 on every changed file — full `check` left to the orchestrator's script.

**Not done, by instruction:** S5 (Permission, D5/`perm-later`/`perm-hold`), S6 (e2e flows + the
simulator Validation: 5 sheets × 3 detents × light/dark, petrol, rotation, AX5, Reduce Motion). **The
native variant's F0 two-child shape and its scroll-to-expand are proven by Step 0's spike and by the
source guards, not on a device in this slice** — S6's simulator pass is where they are confirmed.
`TODO.md` untouched.

### S5 — Permission (D5, keyboard)

*— claude-opus-5-5 (executor), 2026-11-23*

**Load-bearing check (re-run before any edit; log `.tentacle/tmp/mobile-native-sheets/s5-baseline.log`):**
reproduced the missing capability — `PermissionSheet.tsx:131-133` still drew
`<Modal visible={asking !== null || returned !== null} presentationStyle="pageSheet">`,
`PRESENTED_SHEET_KINDS` held **four** kinds (`sheet-plan.ts:304`), `sheetIdentity(kind, null)` at
`App.tsx:2867,2883`, `<PermissionSheetView>` mounted at `SessionScreen.tsx:2077`, and
`perm-later|perm-hold|gestureCancel` appeared nowhere in the app. So the ask was still a JS modal with
a swipe nobody could refuse, and no work of S5 existed yet.

**As built, in order** (all eleven edits; each narrow suite kept green):

1. **`packages/core/src/permission.ts:184`** — `readonly requestId?: string` on
   `PermissionRequestOptions`: process-internal attribution (the daemon's own ask id), documented as
   never on the wire. Additive, no protocol change.
2. **`packages/client/src/remote-client.ts:4721`** — `runPermissionActions`'s `prompt` action now passes
   `action.requestId` into `.request(...)`, so the laptop requester is handed the id. That id is what
   makes the ask's detent identity and its blocked-note key stable across a re-delivery.
3. **`apps/mobile/src/permission-sheet.ts:290`** — `SheetState.asking` gained `requestId: string | null`
   (`entry.options?.requestId ?? null`), so the sheet's state can say WHICH ask is on screen.
4. **`apps/mobile/src/sheet-plan.ts`** — `PRESENTED_SHEET_KINDS` is now all **five** kinds (`:304`);
   `askRouteId` (`:374`, the daemon's id, else `seq:<n>` — a local ask can never collide with a
   numeric `requestId`); `holdKey` (`:382`, `computerId\0sessionId\0askId`, one note per ASK);
   `createSheetHolds`/`SHEET_HOLDS` (`:538`, the app's one store: `note`/`sequence`/`subscribe`/`forget`);
   `askRouteParams` (`:568`, what the ask's route says — read from params because a settled sheet is a
   `returned` reply and holds no id); `askingParamUpdate` (`:597`, the `SET_PARAMS` the route needs, or
   `null` when it already says so).
5. **`apps/mobile/src/routes.ts:88-111,199`** — `SheetRouteParam` gained `askId?`/`asking?`, and
   `updateSheetParams(nav, key, params)` dispatches a `SET_PARAMS` **keyed on `source`**. Verified in the
   library: `BaseRouter.tsx:18-44` merges `{...r.params, ...action.payload.params}` on the route whose
   `key === action.source`, so the patch keeps the pushed identity and `navigate` never REPLACES it
   (which is why a settle is a rewrite in place, not a re-push: the sheet must not blink).
6. **`apps/mobile/src/screens/PermissionSheet.tsx`** — `<Modal>` and `visible` gone, the drawn grabber
   gone (the native one replaces it), new `held: boolean` prop, `perm-later` ("Not now") →
   `sheet.dismiss()` (withdraw, send nothing — the old swipe's semantics, made explicit), and a
   `perm-hold` footnote *"Answer to continue — or Not now"* while `asking && held`. Kept:
   `automaticallyAdjustKeyboardInsets`, the `keyboardDidShow` → `scrollToEnd` fix, `testID="perm-sheet"`.
7. **`apps/mobile/App.tsx`** — the `Sheet` screen's options take `asking` from the route
   (`route.params.asking === true ? { asking: true } : {}`, D5's `gestureEnabled:false`), in the same
   `sheetOptions`/`sheetDetentContext` call; `sheetIdentity(route.params.kind,
   route.params.askId ?? null)` in that call AND in the `sheetDetentChange` listener; a new
   `gestureCancel` listener plays `playHaptic("light")` and calls `SHEET_HOLDS.note(holdKey(…))`.
8. **`apps/mobile/src/screens/SessionScreen.tsx`** — `permission: state.sheet.kind !== "idle"` (a
   `returned` reply still has words to read, so its sheet stays up); the permission element is published
   to `SHEET_HOSTS` with `held` and `undefined` while idle; the push carries `askId` + `asking: true`;
   one effect dispatches `askingParamUpdate` and forgets the ask's note under the ROUTE's id;
   `dismissedNatively`'s `permission` leg runs `sheet.dismiss()`. The ask's own `held` comes from
   `useSyncExternalStore` over `SHEET_HOLDS`, keyed `holdKey(computerId, sessionId, askId)`.
9. **Tests** — `packages/client/test/foreign-turns.test.ts` (the requester is handed the id),
   `apps/mobile/test/permission-sheet.test.ts` (asking carries it, null when the requester had none),
   `apps/mobile/test/sheet-plan.test.ts` (kinds = 5, holds store, `askRouteId`, `askRouteParams`,
   `askingParamUpdate` incl. the second-ask rewrite), `apps/mobile/test/native-sheets-wiring.test.ts`
   (no `<Modal>`, `perm-later` calls `dismiss`, `held` published, push params, gestureCancel notes).
10. **`changelog.d/mobile-native-sheets.changed.md`** — extended, not duplicated: the one existing
    fragment already claimed "Not now"; the blocked-attempt behaviour (light haptic + inline note) was
    missing and is now in the same bullet.
11. **Mutations** (`sh .tentacle/tmp/mobile-native-sheets/mutate-s5.sh`; each applied to the real source,
    the narrow suite run, the file restored from a scratch copy — never `git checkout`, and
    `cmp`-verified byte-identical). Baseline **165 pass / 0 fail** before and after:

| # | Mutation | Result |
|---|---|---|
| M1 | `holdKey` ignores `askId` | 83 pass **1 fail** |
| M2 | `askingParamUpdate` always `null` | 81 pass **3 fail** |
| M3 | `PRESENTED_SHEET_KINDS` back to 4 | 76 pass **7 fail** |
| M4 | `askRouteParams` ignores `askId` | 81 pass **3 fail** |
| M5 | screen: `permission: state.sheet.kind === "asking"` | 51 pass **1 fail** |
| M6 | published element drops `held` | 51 pass **1 fail** |
| M7 | push without `askId`/`asking` | 51 pass **1 fail** |
| M8 | App: `sheetIdentity(kind, null)` | 51 pass **1 fail** |
| M9 | App: `gestureCancel` notes nothing | 51 pass **1 fail** |
| M10 | `perm-later` → `clearReturned()` | 51 pass **1 fail** |
| M11 | a permission swipe runs nothing | 51 pass **1 fail** |
| M12 | client drops `requestId` | 32 pass **1 fail** |
| M13 | sheet hardcodes `requestId: null` | 28 pass **1 fail** |

**Red before green** (AGENTS §9), each shown on the un-fixed source first: `M12`'s red is the new
`foreign-turns` case (`Expected "ask-7" / Received undefined`), `M13`'s is the new
`permission-sheet.test.ts` case, and steps 4/5/6–8's reds are the M3–M11 rows above (they were also
seen before their source edits for M3). No test asserted a weaker correlate: M5 and M6 in particular fail
on the *published element*, and M11 on the dismissal handler itself, which are the exact properties D5
turns on.

**Drift from Implementation (and why):**

1. **`askingParamUpdate` takes an object, not a boolean.** The Implementation says
   `askingParamUpdate(routes, owner, asking)`. The as-built signature is
   `(routes, owner, { asking, askId })`, because a second ask can arrive while the route is already up
   (the sheet presents the queued ask at once): with a boolean alone the route keeps naming the FIRST
   ask, so `sheetIdentity` would restore the dead ask's detent and `holdKey` would attach the new ask's
   note to the old id. M2/M4 and the `SECOND ask` case pin it.
2. **`askRouteParams` exists at all.** The forget-the-note step cannot use `state.sheet`'s `askId`: once
   the ask settles the sheet is a `returned` reply and holds none, so the note would leak and the next
   delivery of the same ask would open already "held". Reading the id back off the route is the only
   place that still knows it. Same module, one new pure reader.
3. **`updateSheetParams` sends a PATCH, not rebuilt params.** `routes.ts` rebuilds nothing: the library
   merges over the route's own params (`BaseRouter.tsx:18-44`), so the pushed identity survives and the
   patch is one property.
4. **S3/S4's `dismissedNatively` body is sliced with `indexOf("}, [actual")`.** S4's wiring test pinned
   `indexOf("}, [actual]);")`; the new `askId` dependency changes that line to `}, [actual, askId]);`.
   The assertion is now the prefix, which pins the same body without pinning a dependency list.
5. **One S2 assertion became a regex.** After `biome --write`, the `sheetOptions(route.params.kind, {`
   call fits on one line, so `native-sheets-wiring.test.ts`'s literal `"...sheetOptions(\n<16 spaces>…"`
   no longer matched. It is now `/\.\.\.sheetOptions\(\s*route\.params\.kind,/` — same property (the
   navigator takes the table's options), no formatting pinned.

**Library facts cited** (`@react-navigation/routers@7.6.5`, read in the bun cache):
`src/BaseRouter.tsx:18-44` — `SET_PARAMS`/`REPLACE_PARAMS` find the route by `action.source`, and only
`SET_PARAMS` merges (`{...r.params, ...action.payload.params}`); an unmatched `source` returns `null`, so
a keyed patch never lands on another route.

**Gate line (this slice, as run by me):** narrow suites green (`sheet-plan`, `native-sheets-wiring`,
`permission-sheet`, `sheet-host`, `foreign-turns`; then the whole `apps/mobile/test` folder **4764 pass /
0 fail** and `packages/client/test` + `packages/core/test` **1751 pass / 0 fail**), `tsc -p apps/mobile`
and `tsc -p packages/client` exit 0, `biome check` **0/0** on all twelve changed files — the full `bun run
check` is the orchestrator's script. No schema change, so `packages/protocol/schema/protocol.json` is
untouched; one changelog fragment (extended); `TODO.md` untouched.

**Not done, by instruction:** S6 (the e2e flows and the simulator Validation: 5 sheets × 3 detents ×
light/dark, petrol, rotation, AX5, Reduce Motion — plus the real-device L2 app-switcher check). In
particular **the blocked-swipe haptic + `perm-hold` note, the `asking` → `gestureEnabled:false` path and
the keyboard inset are proven by the pure tests and the source guards, not on a simulator in this
slice**; S6 is where a finger confirms them.

**Flagged for S4's owner (NOT S5, not fixed here):** `NativeSheetRoute` renders a sheet's content inside
a wrapper `View`, so the route root has ONE direct child and `RNSScreenContentWrapper.mm:122-181` cannot
find the `ScrollView` — `:230-235` falls back to `setFrame(frame)` and sizes it to the whole sheet, which
is F0 for Tools/Info as S4 built them. The permission sheet is a single scroller and is unaffected.

### Owner answers (2026-11-23 ~08:35)

*— claude-opus-5-5 (orchestrator), recording the owner's explicit «Ok» to every recommendation*

1. Detents S/M/L = 0.3/0.5/1.0 for all five sheets; Outbox opens at **M**.
2. Permission while asking: not dismissible by swipe/backdrop; explicit «Not now» (`perm-later`), light haptic + inline «Answer to continue» on a blocked swipe; no undimmed S.
3. Activity stays the JS sheet in this task.

**Implementation APPROVED.**

### Owner decision on F5a (2026-11-23 ~12:55)

*— claude-opus-5-5 (orchestrator), recording the owner*

**A:** the lock wins by DRAINING the sheet stack — when the app locks, and already on `inactive` (before the app-switcher snapshot), `reconcile` pops every native sheet; `desired` survives, so the same sheets re-push after the unlock. Pure JS, reuses the plan's reconcile loop. Needs its OWN simulator proof before S3 (lock `immediately` + Home + relaunch → `lock-screen` visible, no session content in the app-switcher snapshot; unlock → the same sheets back at their detents; an ask pending in a Permission sheet survives as a pending ask). Alternative **B** (the lock presented from the top-most VC / its own `UIWindow`, native) is NOT taken now — parked in TODO (`eval/lock-own-window`). Also: re-check `docs/feat/mobile-lock.md` fact 3, false for this route (F5a).

### Owner answers on Step 0b (2026-11-23 ~14:15)

*— claude-opus-5-5 (orchestrator), recording the owner's «ok» to both*

1. Draining on `inactive` (so Control Center, a call banner or the Face ID prompt also close and re-open the sheets visibly): **accepted** — the price of never showing content in the app-switcher snapshot.
2. L2: **approved** — the spike may run `osascript` to press ⌃⇧⌘H in Simulator.app and screenshot the app switcher.
- **L2 (owner, 23/11 ~14:25):** `osascript` cannot drive Simulator.app from the agent process (`-1728`, no automation permission). Owner chose to verify L2 **on the real phone** during S6's Validation (as `docs/feat/mobile-lock.md` 0.4 accepted). Evidence so far: sheets drained ~1 s before `background`, the relaunch card shows only the lock, native blur on. If L2 fails on the device → alternative B (`eval/lock-own-window`). **Execution may start (S1–S6).**

### Fix round 1

*— claude-opus-5-5, 2026-11-23 (fixing Review round 1, both HIGH)*

**F1 (HIGH): Tools and Session info never opened. FIXED.**
- `src/sheet-plan.ts`: added `userSheet(flags)`. It is pure and turns the three open flags into the ONE user sheet. The fixed precedence is info > tools > commands. Every opener starts from the session UI with no sheet up, so two flags should not be set together; the precedence only makes the result deterministic if they ever are.
- `src/screens/SessionScreen.tsx` (the `desiredStack` call): `user: userSheet({ commands: commandsOpen, tools: toolsOpen, info: infoOpen })`. It replaced `commandsOpen ? "commands" : null`.
- Tests: `test/sheet-plan.test.ts` gets a new `userSheet` describe (each flag alone, desiredStack→`["tools"]`, precedence). `test/native-sheets-wiring.test.ts` (S3 wanted-stack test) now pins the three-flag leg.
- **Red** on the old screen: `(fail) S3 … the wanted stack is desiredStack → managedStack…` with 138 pass / 1 fail. **Green:** 139 / 0.
- **Mutation M-F1:** `if (flags.tools && false)` in `userSheet` gave 2 fail (`each flag alone…`, `two flags at once…`). Reverted.

**F2 (HIGH): the composed tree broke F0 for Tools and Info. FIXED (source-level). The layout still needs a simulator check.**
- `src/screens/NativeSheetRoute.tsx`: the route now returns `<>{snapshot.content as ReactNode}</>`. The `View testID="native-sheet-<kind>" flex:1` wrapper and its `StyleSheet` are gone. Nothing else referenced that testID: rg over `apps/mobile` found only this file, and no e2e flow uses it.
- `src/screens/ToolsSheet.tsx` and `src/screens/SessionInfoSheet.tsx`: the `styles.root` wrapper `View` is removed, and `styles.root` with it. Each component now returns `<Sheet native scroll …>` directly, so `Sheet`'s head (`collapsable={false}`) and its ONE `ScrollView` become the route root's direct children. The `bg` ground still comes from the route's `contentStyle` (`sheetGround`). The rest of the diff in those two files is Biome re-indenting.
- The other three kinds lose only the route's `flex:1` wrapper. Their own root now sits in the same column container, so a child with `flex:1` still fills it. This is unverified on a device; S6 Validation should look at it.
- Tests: three new guards in `test/native-sheets-wiring.test.ts` under "S4 — … ONE scroller". The first checks that the route has no `<View` and returns the bare fragment. The other two check that each of Tools and Info has `return (\n    <Sheet`.
- **Red** before the fix: 3 fail (route, Tools, Info), 52 pass. **Green:** 55 / 0.
- **Mutation M-F2a:** wrapping the route's return in `<View style={{ flex: 1 }}>` gave 1 fail (`the route draws no wrapper`). Reverted.
- **Mutation M-F2b:** wrapping Tools' `<Sheet` in `<View style={{ flex: 1 }}>` gave 1 fail (`Tools returns Sheet itself`). Reverted.

**Checks run:** `sheet-plan`, `native-sheets-wiring`, `hub-tools-wiring` and `sheet-host` gave 162 pass / 0 fail. `tsc -p apps/mobile` is clean. `biome check` on the 7 changed files is clean. The full gate is left to the orchestrator's script.

**Unverified:** these guards check the source shape. The real proof of F0 is S6's simulator check: open Tools and Session info, then confirm the list starts under the pinned head and the close glyph can be tapped.

### Fix round 2

*— claude-opus-5-5, 2026-11-23 (fixing Review round 2, the one MEDIUM)*

**R2 MEDIUM (gate red: `band-screens` "the sheet's ground is the banded ground"). FIXED.** This is a test-only change; no production code changed.
- `apps/mobile/test/band-screens.test.ts:285-294`: the test sliced `SessionInfoSheet.tsx` at `<View style={[styles.root`, and Fix round 1 removed that root. The test now checks the property where it actually lives:
  - `sheetGround("info") === "bg"`, through an import of `../src/sheet-plan`.
  - `App.tsx` gives the route `contentStyle: { backgroundColor: palette[sheetGround(route.params.kind)] }`.
  - `SessionInfoSheet.tsx` never paints `palette.sheet`.
- **Red** on HEAD before the edit: 35 pass / 1 fail (`Expected to contain: "palette.bg"`, `Received: ""`). **Green:** 36 / 0.
- **Mutation M-R2a:** `sheetGround` returns `"sheet"` for `info` too → 1 fail (that test). Reverted.
- **Mutation M-R2b:** the route's `contentStyle` set to `palette.sheet` in `App.tsx` → 1 fail (that test). Reverted. `git diff --stat` afterwards shows only the test file.
- **Checks:** `bunx biome check` on the test file is clean. The full gate is left to the orchestrator's script.

### S6 — e2e flows + Validation

*— claude-opus-5-5 (executor), 2026-11-23*

**Load-bearing check (re-run before any edit, log
`.tentacle/tmp/mobile-native-sheets/s6-baseline.log`).** The gap S6 exists to close is
genuine, on every count:
- `perm-later` / `perm-hold` appeared in **no** flow (rg over `e2e/flows`: no hit), so D5's
  blocked swipe and its explicit way out were unproven on a device;
- **no** flow raised an ask while a user sheet was up (a flow naming `tools-sheet` /
  `session-info-sheet` / `commands-sheet` never ran `laptop-prompt`), so the stacked-sheet
  case was undriven;
- the below-the-fold ids were asserted with a bare `assertVisible`/`tapOn` — `08-permission`
  (`perm-reply`), `08c` (`perm-reply`, `perm-reply-input`, `perm-reply-send`),
  `25-session-info` (`session-info-mcp-demo`, `-mcp-broken`), `34-hub-tools`
  (`tools-mcp:demo`), `34-hub-info` (`session-info-model-Model`) — which a native
  `formSheet` at the MIDDLE detent no longer guarantees;
- no shots flow for the sheets and no lock-with-a-sheet-up flow existed (`ls 42-* 43-*` → no
  hit), and `FLOWS` had no entry for either.

**As built (dependency order).**

1. `apps/mobile/e2e/flows/08-permission.yaml` — the fold: `scrollUntilVisible` to
   `perm-reply`, then D5 driven for real: `swipe start "50%, 55%" → end "50%, 95%"` (from
   the pinned head, past the bottom edge — the gesture RNS's
   `presentationControllerShouldDismiss` refuses), `scrollUntilVisible` to `perm-hold`
   (a blocked swipe still moves the sheet between detents, Step 0 F3, so the note is below
   the fold), re-assert the ask is unanswered, then scroll to `perm-later` (the offered way
   out) and back up to `perm-allow_once` before answering.
2. `08c-permission-reply.yaml` — three `scrollUntilVisible`s (reply pill, reply field, "Send
   reply"), each **before** its tap.
3. `08b-permission-deny.yaml` — `perm-reject_once` (the third option) scrolled to first.
4. `25-session-info.yaml` — `session-info-mcp-demo` scrolled to before the MCP
   assert/switch section (`-mcp-broken` follows it).
5. `34-hub-tools.yaml`, `34-hub-info.yaml`, `34-hub-scheduled.yaml` — the first band / the
   Model band / the revealed Scheduled row are `scrollUntilVisible`d instead of
   `extendedWaitUntil`: at 0.5 nothing of them is guaranteed on screen.
6. **New** `flows/42-native-sheets-shots.yaml` + `flows/42-native-sheets-file.js` — the
   Validation evidence set: Commands at M, Tools at M → dragged UP to L → two drags DOWN to
   S → back UP (`tools-scroll`, the ONE scroller, F8), Session info at M, and a live
   Permission ask at M; each through `_shot` (light + dark). Ends on daemon truth
   (`file-exists?file=ns42.txt`), 12c's rule.
7. **New** `flows/43-native-sheets-lock.yaml` — S3's L1 on a simulator: `immediately`, Tools
   up, `pressKey: Home`, `launchApp {stopApp:false}` → `lock-screen`, **`assertNotVisible
   tools-sheet` and `session-view`** (F5a's exact failure: the cover must win because the
   drain popped the route, not because it is drawn over it), `_unlock` → the sheet is BACK
   (the drain leaves `desired` alone), close it, end on `20-log-dialled.js`.
8. `e2e/run.ts` — `42-native-sheets-shots` in `FLOWS` (after `41-file-view-shots`),
   `43-native-sheets-lock` with the other lock flows (it changes the lock setting), and
   `NATIVESHEETS_ID` / `SHEETLOCK_ID` in `COMPOSE_SESSION_VARS` (one session per flow,
   created just before it runs).
9. `test/e2e-flows.test.ts` (+205 lines, 5 describes): the fold rule per low id + the
   scroll-before-tap ORDER; D5's swipe-then-`perm-hold` order (and that it precedes the
   answer); flow 43's properties (registered, own session, a sheet really up before Home,
   `lock-screen` and no sheet between it and `_unlock`, the sheet back after it, daemon
   truth last); flow 42's (registered, own session, the four shot names unique, the
   UP/DOWN/DOWN/UP drag sequence, each sheet asserted open, daemon truth last); and the
   reverse flow-list guard (no yaml file is silently not run — 74 files vs `FLOWS`).

**Red before green (AGENTS §9).** The whole S6 guard block was written and run on the
**old** flows first: `git show HEAD:…/08-permission.yaml` restored → **52 pass / 3 fail**,
each red on its own assertion (the fold, the swipe, `perm-hold` — no import/module error).
The new-flow guards were red at authoring time because `42`/`43` did not exist (the file
reads throw). Mutations (each applied to the real file, run, reverted; backups in
`.tentacle/tmp/mobile-native-sheets/bak-s6/`):

| # | Mutation | Result |
|---|---|---|
| M1 | `08` drops the `scrollUntilVisible` to `perm-reply` | 54 pass **1 fail** |
| M2 | `08` answers BEFORE the blocked swipe | 54 pass **1 fail** |
| M3 | `43` drops `assertNotVisible tools-sheet` while locked | 54 pass **1 fail** |
| M7 | `43` moves that assert AFTER the unlock (vacuous) | 54 pass **1 fail** |
| M4 | `42` loses its second DOWN drag (one step ≠ two) | 54 pass **1 fail** |
| M5 | `43` unregistered from `FLOWS` | 53 pass **2 fail** |
| M6 | `42` ends on `session-view` instead of the file hook | 54 pass **1 fail** |

Restored → **55 pass / 0 fail**. M7 was added because the first `43` guard passed on
`body.slice(lockAt).toContain("tools-sheet")`, a weaker correlate (it also matches the
post-unlock re-present); the guard is now an index comparison
(`lockAt < notSheetAt < unlockAt`), and M3/M7 both fail on it.

**Drift from Implementation (and why).**

1. **Two flows, not one shots flow.** The Implementation lists
   `{08c,25,29,34-hub-*}` + `42-native-sheets-shots`. `29-tool-rows` needed **no** edit:
   its perm taps are `perm-allow_once`, the sheet's FIRST option, always above the fold —
   editing it would be noise. The lock gate wanted by S3 ("goes into S6") cannot live in a
   shots flow (it changes the app's lock setting and ends on the log, not a screenshot), so
   it is its own `43-native-sheets-lock`.
2. **`34-hub-*` = tools, info, scheduled** (not all ten): commands/attach/artifacts/
   sessions/dictate/new assert nothing that sits below the fold of a native sheet.
3. **The swipe is a `start`/`end` percentage pair, not `from: {id}`.** A `from` id targets
   the element's centre — inside the options, where the drag scrolls the scroller instead of
   dragging the sheet. `"50%, 55%"` is the pinned head, the surface the presentation
   controller judges (the same shape `03-refresh` uses).
4. **`42` shoots Permission with a LIVE ask** (the blocked-swipe evidence is flow 08's) and
   does **not** try Outbox: its only route is an offline item whose basis CHANGED, i.e. flow
   17's whole stop/`serve`/laptop-turn round trip — repeating it here would double the gate's
   cost for one screenshot.
5. **Not automated, by instruction** (the orchestrator's simulator pass, listed in this
   doc's Validation): Outbox at S/M/L, petrol at M, AX5 Dynamic Type, Reduce Motion,
   landscape, Permission-over-Tools, and the real-device L2 app-switcher check (Step 0b:
   `osascript` cannot drive Simulator.app from an agent).

**Verified (narrow, as instructed).** `e2e-flows` + `e2e-gate` + `e2e-shard` +
`e2e-appearance` + `e2e-preflight` + `e2e-escape-probes` → **201 pass / 0 fail**;
`tsc -p apps/mobile` exit 0; `biome check` **0/0** on the three changed JS/TS files (the yaml
flows are not linted, AGENTS §6). No schema change →
`packages/protocol/schema/protocol.json` untouched. Changelog: none added — the S1 fragment
(`changelog.d/mobile-native-sheets.changed.md`) already describes the feature end to end and
e2e flows are dev/test-only, which the changelog discipline excludes. The full gate is the
orchestrator's.

**Not done, by instruction:** the simulator Validation itself (the 5×3×light/dark matrix and
its extra checks) — the orchestrator runs it after this slice. **Unverified:** every flow
edit here is a claim about a finger on a sheet; the 0.5-detent fold estimates (which ids land
below it) come from the sheets' contents, not from a screenshot, and neither `42` nor `43`
has ever run. `TODO.md` untouched.

### Validation (simulator)

*— claude-opus-5-5 (validator), 2026-11-23*

**Source.** The orchestrator's full gate on this branch (iOS 26 simulator, Release build):
`.tentacle/tmp/orchestration/runs/e2e-gate-mobile-native-sheets.log` → **GATE FAIL, 57 pass /
6 fail / 7 quarantined**, results `.tentacle/tmp/e2e-mobile/1795466539487/`. The six fails:
`08-permission` (no `perm-hold`), `08c-permission-reply` (no `perm-reply-input`),
`25-session-info` (no `session-info-mcp-demo`), `34-hub-scheduled` (no "WAKEPING hub" row),
`42-native-sheets-shots` (`tools-sheet` not visible after the drag back up — it is on screen, see
below), `43-native-sheets-lock` (`app-content` never visible in `_unlock`). No re-run: `42` would
fail at the same step, so a re-run adds no shot. Every PNG below was opened and looked at; copies in
`docs/feat/mobile-native-sheets/validation/`.

| File | What it shows |
|---|---|
| `commands-M-light.png` / `commands-M-dark.png` | Commands at the middle detent (top edge ≈ 52 % of the screen), grabber, close ×, title and subtitle pinned, the list starts below them (F0 holds here). Both themes are correct. |
| `tools-M-light.png` / `tools-M-dark.png` | Tools at M: pinned head, MCP/Skills segment, search, `demo`/`broken` rows, Refresh. Correct in both themes. |
| `tools-drag-up-expected-L-still-M-light.png` / `…-content-scrolled-dark.png` | After the flow's drag UP (named `42-tools-L`): **the sheet is still at M**, the same top edge. In dark the *content* scrolled (the segment slid under the pinned head), so the drag went to the scroller and not to the sheet. |
| `tools-drag-down-expected-S-still-M-light.png` / `…-dark.png` | After two drags DOWN (named `42-tools-S`): **still M**, the same height as before. A light-theme scroll indicator is visible. |
| `tools-drag-up-again-still-M-flow42-fail.png` | `42`'s failing step: Tools is plainly on screen, at M, with the content scrolled. The assert `tools-sheet` "not visible" fails anyway. Session info and Permission shots of `42` never ran. |
| `session-info-M-light.png` / `session-info-M-dark.png` | Session info at M (from flow 25): pinned head, MODEL and SESSION bands. Correct in both themes. |
| `session-info-M-mcp-below-fold-no-scroll-light.png` | `25`'s fail: the same frame **after** `scrollUntilVisible` — nothing scrolled, and the MCP band stays below the fold. |
| `permission-M-reply-field-below-fold-no-scroll-light.png` | Permission at M (08c): the four options and Auto-accept. After tapping "No, let's talk about it", the reply field is below the fold and `scrollUntilVisible` did not scroll to it. |
| `permission-after-blocked-swipe-still-up-lower-detent-no-perm-hold-light.png` | `08` after D5's swipe: **the sheet is still up and the ask is unanswered** (title dot, `Write a.txt` row 24 s). The swipe only moved it to a lower detent (top ≈ 70 %, Deny is cut off). The `perm-hold` note never appears, and nothing scrolls to it. |
| `lock-after-unlock-tools-restored-app-content-unseen-light.png` | `43` after `_unlock`: Tools is **back, at M**, over the session. |

**Against the plan's Validation:**
- **Each sheet × S/M/L × light/dark — NOT met.** On screen there is only **M**, for Commands,
  Tools and Session info, in both themes. On iOS 26 the flow's drags never moved a user sheet to
  S or L: they scrolled the content, or did nothing. The shots named `L`/`S` are mislabelled M
  frames. Permission was never shot in dark. Outbox was not shot at all, by design (S6 drift 4).
  Petrol is also missing.
- **Permission not swipe-dismissible — met for dismissal:** after the swipe the sheet is still
  up and the ask is still live. **Not met for `perm-hold`:** the note never appears, so D5's
  explanation and way out are not shown.
- **Lock drains the sheets — the property passed, but there is no picture of it.**
  `commands.json` of `43` records `lock-screen` visible, then `assertNotVisible tools-sheet` and
  `assertNotVisible session-view` **COMPLETED**, all before `_unlock`, which is F5a's exact
  property. After the unlock the sheet re-pushed (`desired` survived), as the screenshot shows.
  The flow then fails inside `_unlock`, because `app-content` is never reported visible while
  the re-pushed sheet is up. A plausible cause, not verified: the native sheet hides the
  presenter from the accessibility tree. No frame captured the lock cover itself, so the drain is
  proven by the assertions only.
- **Common pattern (not diagnosed here).** Inside the native sheets, `scrollUntilVisible` and the
  drags do not behave as the flows assume. Session info and Permission do not scroll at all
  (`25`, `08`, `08c`). Tools scrolls, but its detent does not move. `42`'s "not visible" assert
  fails on a sheet that is on screen, which is the same blindness as `43`'s `app-content`. This
  matches the "Write a file" not-found note in Step 0b. Whether this is the app (the scroller does
  not fill, F0) or Maestro's view of a `formSheet` is the next cheap test to run. Not touched:
  `34-hub-scheduled`.
- Not attempted, by instruction or because nothing scripted them: L2 (the owner's on-device
  check), AX5, Reduce Motion, landscape, Permission over Tools, keyboard checks.

## Review

*— claude-opus-5-5, 2026-11-23 (fresh context; same model family as the S1/S2/S4/S5 executor, so shared blind spots are possible)*

**Verdict: REQUEST-CHANGES** (scope: S1–S5, `git diff main...HEAD`).

Gate as run by me: `bun run typecheck` clean (root + mobile + relay); `bun run lint` clean (2324 files, 0/0); the touched suites (`sheet-plan`, `sheet-host`, `native-sheets-wiring`, `app-lock`, `permission-sheet`, `commands-sheet`, `band-wiring`, `band-screens`, `hub-tools-wiring`, `client/foreign-turns`) → 323 pass / 0 fail. Full `bun test` not run here.

**Findings**

1. **HIGH — Tools and Session info can never open.** `apps/mobile/src/screens/SessionScreen.tsx:1222-1229`: `desiredStack({ user: commandsOpen ? "commands" : null, … })` never names `"tools"` or `"info"`, even though `toolsOpen`/`infoOpen` are set (`:1077`, `:1097`) and S4 removed both `<Modal>`s and added both kinds to `PRESENTED_SHEET_KINDS`. So `reconcile` never pushes them. *Scenario:* tap the Tools glyph or the hub's Session info → `setToolsOpen(true)` → nothing appears (only the floating button hides, `:1048-1050`). Every e2e flow on `tools-sheet` / `session-info-sheet` (25, 29, 34-hub-*) breaks, and so does the reveal-at-L path. No test catches it: the wiring suite pins the `commands` leg literally (mutating it to `user: null` → 1 fail), but no tools/info leg exists to pin. Fix: derive `user` from all three flags (one user sheet, in a precedence order the pure module decides) and add a red-first wiring/pure test.
2. **HIGH — F0 layout shape is broken for the `Sheet native` sheets (Tools, Info).** `NativeSheetRoute.tsx:42-45` wraps the content in `<View testID="native-sheet-…" style={flex:1}>`, and `ToolsSheet.tsx:122` / `SessionInfoSheet.tsx:371` wrap `Sheet` in another `styles.root` `View`. `Sheet native`'s two-child fragment (`ui/Sheet.tsx` native branch) is therefore two levels below the route root, which is exactly the F0 failure Step 0 recorded (RNS sizes the ScrollView to the whole sheet, so the list is drawn over the pinned head and the close/segments/search can't be tapped). The S5 executor flagged this and left it open. Mutation M3 (S4) checks only `Sheet.tsx`, so the source guards pass while the composed tree breaks F0. Fix: render the content as the route root's direct children (no wrappers on the native path) and pin the composed shape in a test.

**Attacks tried (and what came of them)**
- Lock drain: it pops every key in one pass, marks them planned, and only spends the pops that landed (`:1367-1376`, `:1433-1439`). With `locked` taken from `lockInstance.subscribe`, it holds. No finding.
- Lower-sheet pop (F4): `reconcile` is top-only, and the user-close path waits for the permission sheet above it. No finding.
- Double-close / Session pop: `popSheet` and `updateSheetParams` are keyed on `source`. No `goBack(` in sheet code. No finding.
- Single broker (§7): the `PermissionSheet` object is unchanged. `requestId` is process-internal (core/client) and never reaches the wire. No finding.
- Mutation: `user: null` → 1 fail. Reverted, and `git status` is clean.

**Executor behaviour:** thorough mutation tables per slice and honest drift notes. But S4 shipped the Modal removal without the `desiredStack` leg that replaces it, and the F0 regression was noticed in S5 and deferred instead of being called a blocker. The guards check each file on its own, not how the files compose.

### Round 2

*— claude-opus-5-5, 2026-11-23 (diff `212e4cd6..HEAD`: the fix round `00ebbe6a` + the gate fix `180ef735`)*

**Verdict: REQUEST-CHANGES.** Both round-1 HIGH findings are fixed and pinned. One test regression remains.

- **R1-F1 (Tools/Info never open): FIXED.** `userSheet` (`sheet-plan.ts`) feeds `desiredStack` from all three flags (`SessionScreen.tsx:1224`). Mutation `info: false` at the call site → wiring test red. Mutation `flags.info && false` in `userSheet` → 2 `userSheet` tests red. Both reverted.
- **R1-F2 (composed F0 shape): FIXED (source level; S6 still needs the simulator check).** `NativeSheetRoute` returns a bare fragment, and Tools/Info return `<Sheet native scroll>` with no wrapper. Mutation `<View>` around the route's fragment → "the route draws no wrapper" red. Reverted.
- **NEW — MEDIUM: the gate is red.** `apps/mobile/test/band-screens.test.ts:284-292` ("the sheet's ground is the banded ground") slices `SessionInfoSheet.tsx` at `<View style={[styles.root`, which the fix removed. It fails alone (35 pass / 1 fail) and in `bun test apps/mobile/test` (4769 pass / 1 fail). So `bun run check` fails. The property itself still holds through the route's `contentStyle` = `palette[sheetGround("info")]` = `bg`. The test should be repointed at that (or at `sheetGround`), not deleted.
- `bun run typecheck` clean. `bun run lint` clean (2324 files). After the reverts the tree is byte-identical (`git status` empty).
- Regressions attacked: (a) Commands/Outbox/Permission lose the route's `flex:1` wrapper. Each still has its own root, and RN's ScrollView has `flexGrow:1` by default, so the risk is low but unverified on a device (S6). (b) No test or e2e flow references `native-sheet-<kind>` (rg). (c) info > tools > commands precedence: there is no opener path where two flags are set together (`openInfo`/`openTools`, `SessionScreen.tsx:1075-1098`). No finding.

### Round 3

*— claude-opus-5-5, 2026-11-23 (diff `HEAD~1`, `2e11bfbc`)*

**Verdict: PASS** (scope S1–S5; S6's simulator checks for F0, keyboard, `perm-hold` and L2 are still open, as the plan says).

- **R2 (band-screens test red): FIXED.** `band-screens.test.ts:285-295` now asserts the property where it lives: `sheetGround("info") === "bg"`, App.tsx's `contentStyle: { backgroundColor: palette[sheetGround(route.params.kind)] }`, and no `palette.sheet` in `SessionInfoSheet.tsx`. Mutation `sheetGround` → `"sheet"` for `info` → the test goes red (35 pass / 1 fail). Reverted; `git status` empty.
- Gate: `bun run typecheck` clean; `bun run lint` clean (2324 files); `bun test apps/mobile/test` → **4770 pass / 0 fail**. The full root `bun test` was not run by me.
- Regressions on this diff: test-only plus doc. The import is `../src/sheet-plan` without `.ts`, unlike its neighbours, but typecheck and lint accept it. No finding.
