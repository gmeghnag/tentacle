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
| L2 | **NOT PROVEN** | The switcher could not be opened on the simulator. Maestro has no app-switcher command. A bottom-edge swipe-and-hold only drags the sheet (`L2-x-edge-swipe-no-switcher`), and `osascript` (Simulator ⌃⇧⌘H) was not approved in this session. Indirect evidence: (a) the stack is empty ~1 s before `background` (L1 log); (b) the relaunch card iOS animates from shows the lock only (`L1-a`); (c) the native expo blur is on for `immediately` anyway (`switcher-cover.ts`). This is the same gap as `docs/feat/mobile-lock.md` 0.4. | `L2-x-edge-swipe-no-switcher` |
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

## Review

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
