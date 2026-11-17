# feat/mobile-hub-opacity — Floating hub button opacity (Settings slider)

> **Status:** implementation approved (owner 17/11)
> **Branch:** `feat/mobile-hub-opacity`
> **Type:** feat · **Size:** M · **Blast:** contained · **Suited:** DeepSeek exec + standard review
> **Changelog:** `changelog.d/mobile-hub-opacity.added.md`

Size corrected S → M: seven files in one package (a pure module, the settings
store, the button, Settings, two wiring sites, an e2e flow), not one module.
Blast stays `contained`, with one caveat: the one persisted change is an
**additive optional field** in a phone-local Keychain record (no `v` bump, see
Design 1). That is a persisted-format edge, so Review must re-run the store's
fail-safe rules (F22) against the new field.

## Context

*— claude-opus-5-5, 2026-11-17*

The floating hub button (`apps/mobile/src/ui/FloatingActivity.tsx`, H3 of
`docs/feat/mobile-hub.md`) is an opaque 54 pt glass circle. It covers the
transcript text under it. Today it has no opacity setting: its body has only
the show/hide fade (`FloatingActivity.tsx:108`, `:133-141`, applied at `:375`).

Owner decisions (2026-11-17, final; mockups in
`.tentacle/mockups/mobile-hub-opacity/`, variant **B**):
- Settings → a new "Button opacity" band under "Activity button": a continuous
  slider from 30 to 100 % with a live preview (mockup `settingsB`, index.html:147-159).
  The floor is 30 %, so the button is never invisible.
- At rest the button renders at the set value. It goes to **100 %** while it is
  touched (tap, long-press) and while the fan is open. It returns to the set
  value when the fan closes.
- The running-turn arc (`hub-arc`) stays at 100 % at any setting. Below 75 % it
  gets thicker (2 → 3 pt) and gains a halo in the page colour
  (index.html:61-72: `low = o < 0.75`, `sw = 3`, halo `stroke = t.page`, width `sw + 3`).
- iOS Reduce Transparency on → always 100 %.
- The decision is a pure function in a React-free module (AGENTS §7); the
  component only applies it.
- Not wanted: a number inside the header context ring.

Note: the mockup README still stars **D**. The owner's final choice is **B**,
and B is what this doc builds.

**Repro (capability missing):** `rg -n "opacity" apps/mobile/src/activity-settings-store.ts`
→ no match (2026-11-17). The record holds only `{v, mode, position?}`
(`activity-settings-store.ts:23-27`). Settings has no "Button opacity" band:
the only Activity band is at `SettingsScreen.tsx:346-375`.

## Implementation

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**The arc can be kept out of the opacity layer.** Today the arc is a CHILD of
the one `Animated.View` whose `opacity` is the show/hide fade
(`FloatingActivity.tsx:358-378`, arc `:391-410`). If the rest opacity were put
on that view, the arc would dim with it. The plan therefore splits the circle
into two layers, both inside the outer view, which keeps the fade, the
transform and the pan handlers:
- a **body** layer: blur, glass fill, border, glyph/badge. It carries the rest
  opacity.
- the **arc**, as a sibling of the body. It only follows the outer fade.

RN multiplies a parent's opacity into its children, so the arc's effective
opacity is `fade × 1` and the body's is `fade × level`. The executor proves
this on the simulator, with the 30 % running-turn screenshot (Tests).

### Preconditions

- Settings seam: the store/holder `activity-settings-store.ts:90-168` and the
  Keychain adapter `activity-settings-expo.ts:14-19`. `parse` ignores unknown
  fields (`:72-80`), so an older build reads a record that has `opacity` and
  keeps working.
- Every write spreads the current settings first: `App.tsx:1626`
  (`{ ...current(), mode }`) and `SessionScreen.tsx:1191`
  (`{ ...current(), position }`). A mode change or a drop therefore keeps the
  opacity, and the new write keeps both of the others the same way.
- The press machine's states are `idle | pressing | dragging | fanTracking |
  fanSticky` (`hub-gesture.ts:52-69`). They are read via `driver.state()`
  (`hub-session.ts:258`). A press emits no effect on down
  (`hub-gesture.ts:108`), so "touched" must be read from the state. It cannot
  come from an effect.
- RN 0.88 exposes `AccessibilityInfo.isReduceTransparencyEnabled()` and the
  `reduceTransparencyChanged` event (iOS; `react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo.js:32,67,397`).
  These flags are already read live in `useAccessibilityFlags`
  (`FloatingActivity.tsx:51-67`, used at `SessionScreen.tsx:711`).
- There is no slider in the app: no slider dependency in `apps/mobile/package.json`,
  and RN core has none. A PanResponder track (core RN) matches the button's
  "no gesture library" choice (`FloatingActivity.tsx:8-11`) and needs no
  native rebuild.
- Timing: `motion(reduceMotion).fadeMs` (`floating-button.ts:118-123`).

### Design

1. **Store** (`activity-settings-store.ts`): add `readonly opacity?: number`
   (a percentage) to `ActivitySettings`. Keep **v1**, because the field is
   additive: bumping `v` would make every older build treat the record as
   unreadable and refuse to write it (rule 2), which is worse than an old
   build dropping a field it does not know. `parse` rules:
   - a non-finite or non-number `opacity` → absent (the mode and position are
     kept, like a bad position at `:76`);
   - a number → `clampOpacity` (below).
   - Absent means the default, **100** (today's look).
2. **Pure module** `apps/mobile/src/hub-opacity.ts` (React-free):
   - `OPACITY_MIN = 30`, `OPACITY_MAX = 100`, `OPACITY_DEFAULT = 100`.
   - `clampOpacity(n)`: rounds to an integer and clamps to [30, 100].
   - `hubOpacity({ setting, gesture, fanOpen, reduceTransparency })` → `{ body, arc }`:
     - `body` is `1` when `reduceTransparency`, when `fanOpen`, or when
       `gesture !== "idle"`; otherwise `clampOpacity(setting ?? 100) / 100`;
     - `arc` is `{ width: body < 0.75 ? 3 : 2, halo: body < 0.75 }`.
       The arc's own opacity is always 1.
   - `opacityAt(x, width)`: track x → `clampOpacity` (30 + ratio × 70). A
     zero or negative width returns the floor, so it never divides by zero.
   - `stepOpacity(v, dir)`: ±5, clamped. VoiceOver's `adjustable`
     increment/decrement uses it.
3. **Button** (`FloatingActivity.tsx`):
   - new prop `opacity: number | undefined`; `useAccessibilityFlags` gains
     `reduceTransparency` (read live, the same pattern as reduceMotion);
   - `engaged` state = `driver.state().kind`. It is synced after each
     `driver.down/up/cancel/tapOverlay` call and at the end of `apply` (the
     hold timer opens the fan through `apply`);
   - the body layer gets `Animated.timing` toward `hubOpacity(...).body`:
     - to 1: instant, so touching the button gives feedback at once;
     - back down: `fadeMs` (instant under Reduce Motion);
   - the arc's `borderWidth` comes from `arc.width`, and the halo is drawn
     when `arc.halo` is true. The halo is a View behind the arc with the same
     geometry, `borderTopColor: palette.page`, and width `arc.width + 3`.
   - The shadow's opacity is scaled by `body`, so a faint body does not cast
     a full shadow.
4. **Settings** (`SettingsScreen.tsx`): a "Button opacity" `BandSection`
   right after the Activity band (`:346-384`), shown only when
   `activityMode === "floating"` (Owner Q1). It contains:
   - a label row "Opacity" with the value `NN%`;
   - a 2 pt track with an accent fill and a 22 pt thumb, with "30%" / "100%"
     under the ends;
   - a live preview: a 54 pt glass circle with the glyph and a running arc,
     over two lines of sample text;
   - the footnote from the mockup ("Solid while you touch it, and the working
     arc always stays solid.").
   The drag updates a local value for the label and the preview. **One write
   happens on release** (a Keychain write per move is too many). The row is
   disabled when `activityWritable` is false. VoiceOver uses
   `accessibilityRole="adjustable"`. testIDs: `hub-opacity-slider`,
   `hub-opacity-value`, `hub-opacity-preview`.
5. **Wiring:**
   - `App.tsx` passes `hubOpacity={activitySettings.opacity ?? 100}` and
     `onHubOpacity` (`set({ ...current(), opacity })`). A failed write sets
     the existing `activityError`.
   - `SessionScreen.tsx:1170` passes `opacity={activitySettings.opacity}` and
     `reduceTransparency={a11yFlags.reduceTransparency}`.

### Files

1. `apps/mobile/src/hub-opacity.ts` (new) + `apps/mobile/test/hub-opacity.test.ts` (new)
2. `apps/mobile/src/activity-settings-store.ts` + `apps/mobile/test/activity-settings-store.test.ts`
3. `apps/mobile/src/ui/FloatingActivity.tsx`
4. `apps/mobile/src/screens/SettingsScreen.tsx`
5. `apps/mobile/App.tsx`, `apps/mobile/src/screens/SessionScreen.tsx`
6. `apps/mobile/e2e/flows/33-hub.yaml`
7. `changelog.d/mobile-hub-opacity.added.md`

### Failure modes

- **Unreadable or out-of-range stored value:** absent → 100, a number is
  clamped. The button is never invisible, and the floor is enforced at read,
  at write and at render (`hubOpacity` clamps again).
- **Downgrade:** an older build ignores `opacity`, and its next write drops
  it. The button falls back to 100 %, which is safe. The setting is lost, and
  that is accepted.
- **Newer build's record (v ≠ 1):** the existing rule 2 applies. The slider is
  disabled and says why, and nothing is written.
- **Write fails:** the holder still publishes the value for this run
  (`:157-161`), and Settings shows the existing error banner.
- **Missed sync:** `engaged` could stay true after a close path. In that case
  the button stays solid, which fails safe (it never goes faint while
  touched). A test pins every close path: tap overlay, cancel, dispose,
  commit, drop and dragCancel.
- **Reduce Transparency toggled mid-session:** it is read live, so the button
  converges without a restart.
- **Header mode:** the band is hidden, and the stored value is kept for when
  the user switches back.

### Tests

- `hub-opacity.test.ts`:
  - rest = setting;
  - pressing, dragging, fanTracking and fanSticky → 1;
  - fanOpen → 1, and closing it returns to the setting;
  - Reduce Transparency → 1 at 30 %;
  - clamp: 0, 29.6, 101, NaN and undefined;
  - arc width and halo at 74 / 75 / 100;
  - `opacityAt` at both ends and with width 0;
  - `stepOpacity` at both bounds.
- `activity-settings-store.test.ts`:
  - round-trip with `opacity`;
  - a bad `opacity` (string, NaN) → absent, with mode and position kept;
  - 10 → 30 and 150 → 100;
  - a mode write keeps the opacity (holder spread).
- Mutation check (§9): make `hubOpacity` ignore `fanOpen`, or move the arc
  back inside the body layer. The unit test, or the 30 % running-turn
  screenshot, must show the failure. Then revert.
- `33-hub.yaml` (cheap extension):
  - after picking Floating, drag `hub-opacity-slider` to its left end and
    assert `hub-opacity-value` reads "30%";
  - in the session, take the shots `33-hub-opacity-30` (rest) and
    `33-hub-opacity-30-running` (during the HOLD turn);
  - the existing `33-hub-fan` shot shows 100 % with the fan open;
  - then take the shots at 100 %.
  - Light and dark come from `_shot.yaml`; copies go to
    `.tentacle/tmp/mobile-hub-opacity/shots/`.
  - Not driven: Reduce Transparency, which is not reliably togglable in
    Maestro (the same limitation is stated at `33-hub.yaml:17`). The unit
    tests pin it.
- Gate: `bun run check` green.

### Owner questions

1. **Header mode:** should the "Button opacity" band be hidden or disabled
   when the Activity button is set to Header? *Rec: hidden. The setting has no
   effect there, and the stored value is kept.*
2. **Default for existing and new users:** 100 % (today's look, dimming is
   opt-in) or a dimmer value such as 70 %? *Rec: 100 %. Nothing changes
   until the user moves the slider.*

### Owner answers (2026-11-17)

Owner confirmed both recommendations: Q1 Header mode → the "Button opacity" band is HIDDEN (the stored value is kept); Q2 default 100 %. Implementation APPROVED. Owner also: no number inside the header context ring.

## Execution

## Review
