# feat/mobile-hub-defaults — Floating hub on by default at 80 %, a stepped opacity slider

> **Status:** execution
> **Branch:** `feat/mobile-hub-defaults`
> **Type:** feat · **Size:** S · **Blast:** contained · **Suited:** Opus exec + Opus review
> **Changelog:** `changelog.d/mobile-hub-defaults.changed.md`

## Context

*— claude-opus-5-5, 2026-11-18*

Owner brief (TODO.md, 2026-11-18 ~10:55): the floating hub button should be ON
by default, at 80 % opacity; the "Button opacity" slider of
`docs/feat/mobile-hub-opacity.md` becomes five discrete steps of 20 % —
20 · 40 · 60 · 80 · 100 (floor 20 %, was a continuous 30–100 %) — with a light
haptic tick per step; a stored off-step value snaps to the nearest step; the
button stays at 100 % while the fan is open.

State on `main` (4459c213) before any edit:

- `DEFAULT_ACTIVITY_SETTINGS = { mode: "header" }`
  (`apps/mobile/src/activity-settings-store.ts:39`): a fresh install gets the
  header pill; the hub is opt-in.
- `clampOpacity` (`apps/mobile/src/hub-opacity.ts:50-55`): any whole number in
  30–100; `opacityAt` maps the track linearly onto it, `stepOpacity` moves ±5
  (VoiceOver). `OPACITY_DEFAULT = 100` is what an absent `opacity` field means.
- `HubOpacityBand.tsx` plays no haptic; the drag is continuous.

**Repro** (feat: the capability is missing) — the tests below were written
first and run against `main`'s four source files (copied back over the branch's
for the run, then restored from `.tentacle/tmp/mobile-hub-defaults/bak/`),
2026-11-18:

```
$ bun test apps/mobile/test/hub-opacity.test.ts apps/mobile/test/activity-settings-store.test.ts apps/mobile/test/hub-opacity-steps-wiring.test.ts
# Unhandled error between tests
SyntaxError: Export named 'opacityStepHaptic' not found in module '.../apps/mobile/src/haptic-rules.ts'.
(fail) the slider is stepped, not continuous > the stored value is SNAPPED (an off-step record shows as its step)
(fail) the slider is stepped, not continuous > the five steps' marks are drawn from the shared constant
(fail) a tick per step: the drag plays `opacityStepHaptic` > every move goes through the rule, from what the slider showed before
(fail) a tick per step: the drag plays `opacityStepHaptic` > `shownNow` mirrors the rendered value (the grant compares against it)
(fail) opacity: an additive optional field in the same v1 record > an off-step or out-of-range opacity snaps to the nearest step (ties up)
(fail) rule 1: … > the default is the floating hub at 80 % (owner 2026-11-18; was Header)
(fail) rule 1: … > a fresh install reads the floating hub at 80 %
(fail) rule 1: … > switching mode on a fresh install keeps the 80 % (the holder spread writes it)
 27 pass
 9 fail
 1 error
```

(`hub-opacity.test.ts` is the "1 error": it imports `snapOpacity`,
`OPACITY_STEPS` and `opacityStepHaptic`, none of which exist on `main`, so the
whole file is red.)

## Implementation

*— claude-opus-5-5, 2026-11-18*

### Load-bearing assumption

Only a MISSING or unreadable record reads `DEFAULT_ACTIVITY_SETTINGS`; a
readable v1 record is returned as stored. Proof: `parse`
(`activity-settings-store.ts:72-101`) returns the defaults for `raw === null`
and for the unreadable shapes, and otherwise builds `settings` from `r.mode` /
`r.position` / `r.opacity` alone — the defaults are never merged into a stored
record. So changing the default cannot move a phone that already chose.

### Decisions

1. **A stored "header" stays "header".** Only a phone with no readable record
   (fresh install, a wiped Keychain, an unreadable / newer record) gets the new
   default. Rationale: the record IS the user's choice; overriding it on upgrade
   would undo a pick silently. **How the owner switches if their phone stored
   "header":** Settings › Activity button › **Floating**; the Button opacity
   band then appears below it — tap or drag to the **80 %** step (see 2).
2. **A stored record with no `opacity` keeps meaning 100 %.**
   `OPACITY_DEFAULT` stays 100 (the absent field's meaning, owner Q2 of
   mobile-hub-opacity: "nothing changes until the user moves the slider"); the
   80 % lives in `DEFAULT_ACTIVITY_SETTINGS = { mode: "floating", opacity: 80 }`
   (`OPACITY_FIRST_RUN`). So a phone that picked Floating before the slider
   existed stays solid; a fresh install is at 80 %. A mode switch on a fresh
   install writes the 80 into the record (the holder spreads `current()`,
   `App.tsx` `selectActivityMode`), so it survives Header ↔ Floating.
3. **Snapping: nearest step, ties UP.** `snapOpacity(n) =
   clamp(floor((n + 10) / 20) × 20, 20, 100)`: 35 → 40, 45 → 40, 30 → 40,
   50 → 60, 70 → 80, 90 → 100, 10 → 20, 29.9 → 20; NaN → 20 (never invisible);
   ±∞ → its end. Ties go up because up is the safer side (more visible). An
   off-step record is snapped on READ and on render; it is not rewritten until
   the user changes the setting (no write on load).
4. **The haptic is the selection `tick`** (`Haptics.selectionAsync`, the
   detent click of a stepped iOS slider — the lightest feedback iOS has), played
   when a drag lands on ANOTHER step; moves inside one step's band are silent,
   so a full-track drag ticks four times. VoiceOver's increment/decrement plays
   none (VoiceOver announces the new value itself). The release plays none.
5. **VoiceOver step = one step (±20).** `accessibilityValue` min/max follow
   `OPACITY_MIN`/`OPACITY_MAX` (20/100).
6. **Fan open → 100 %:** unchanged (`hubOpacity`'s `engaged` rule); pinned at
   the 80 % setting by a test.

### Preconditions

- The track is the touch target and `locationX` is the track's own x
  (`HubOpacityBand.tsx` comment on `PanResponder`): `opacityAt(x, width)` is
  the only map from a touch to a value, so snapping it snaps the drag.
- `HubOpacityBand` writes ONCE per gesture, on release (`commit`) — unchanged;
  the haptic is in `dragTo`, which runs on grant and every move.
- `haptics.ts` already has the `"tick"` kind (`Haptics.selectionAsync`).

### Design / files (dependency order)

- `apps/mobile/src/hub-opacity.ts` — `OPACITY_MIN = 20`, `OPACITY_STEP = 20`,
  `OPACITY_STEPS`, `OPACITY_FIRST_RUN = 80`; `clampOpacity` → `snapOpacity`
  (decision 3); `stepOpacity` moves one step.
- `apps/mobile/src/haptic-rules.ts` — `opacityStepHaptic(from, to)` (decision 4),
  next to the other "when to play" rules.
- `apps/mobile/src/activity-settings-store.ts` — the new default (decisions 1–2),
  `parseOpacity` snaps.
- `apps/mobile/src/ui/HubOpacityBand.tsx` — renders the five step marks
  (`hub-opacity-detent-<n>`), plays `opacityStepHaptic(dragged ?? shownNow,
  next)` in `dragTo`, snaps the stored value.
- `apps/mobile/e2e/flows/33-hub.yaml` — a fresh install reads 80 %, shot of the
  band at 80; the left-end drag reads 20 %. `27-activity.yaml` — picks Header
  first (its subject is the header pill, no longer the default).

### Failure modes

- Off-step legacy record (35) → shows 40, writes nothing until changed; a
  VoiceOver step from it starts at 40.
- Junk / NaN opacity in a v1 record → dropped (`parseOpacity` keeps the
  number check), mode kept; a junk value at render → the 20 % floor.
- Unreadable / newer record → defaults (floating 80), not writable: the band
  is disabled and says so (unchanged).
- Before `load()` resolves, the holder's `current()` is the default (now
  Floating): a phone that stored Header could see the hub for the length of one
  Keychain read at launch. `load()` runs at App mount, before any session screen
  is opened by a tap, so in practice it is not visible; noted, not designed out.
- The held released value (`settledReleased`) compares snapped values, so a
  stored 35 settles a held 40.

### Tests

- `hub-opacity.test.ts` — steps, snapping (nearest, ties up, bounds, NaN/±∞),
  `opacityAt` returns only steps and each step's band, ±20 VoiceOver step,
  `opacityStepHaptic` (tick on another step, silent within one, four ticks on a
  full drag), the arc rule at 60/80/100, fan open → 1 at 80 %.
- `activity-settings-store.test.ts` — default `{floating, 80}`; fresh install
  reads it; stored Header stays Header; stored Floating without opacity stays
  without (100 %); a mode switch on a fresh install writes the 80; off-step
  records snap (35 → 40, 30 → 40, 62.6 → 60, 70 → 80, 10 → 20, 150 → 100).
- `hub-opacity-steps-wiring.test.ts` (new) — the band snaps the stored value,
  maps touches through `opacityAt`, draws the `OPACITY_STEPS` marks, exposes
  20–100 to VoiceOver, and plays `opacityStepHaptic` in `dragTo` BEFORE the
  live value moves on (else it would never tick), never on release.

## Execution

*— claude-opus-5-5, 2026-11-18*

As planned, no drift from the decisions above.

1. Tests written first (above), shown red against `main`'s sources (Repro).
2. `hub-opacity.ts`, `haptic-rules.ts`, `activity-settings-store.ts`,
   `HubOpacityBand.tsx` changed; the existing hub-opacity / store tests that
   pinned the 30 % floor, ±5 steps and the Header default were updated to the
   new rules (values moved onto steps: 55 → 60, 45 → 40, 30 → 20 …).
3. e2e flows 27 and 33 updated (see Design).

4. Drift: `hub-opacity-wiring.test.ts:319` pinned `clampOpacity(...)` in the
   band's source — renamed to `snapOpacity` (the full suite caught it).
5. Drift: on the iPhone 17 Pro Max the opacity band is below the fold, so flow
   33 scrolls down to `hub-opacity-preview` and back up to `settings-back`.

Gate (2026-11-18):

- `bunx tsc --noEmit` ✓ · `bunx tsc -p apps/mobile --noEmit` ✓ ·
  `bun run lint` ✓ (0 errors / 0 warnings).
- Full `bun test` (one run): `15275 pass · 5 skip · 1 fail` — the one fail
  was the `clampOpacity` source pin (item 4), fixed after; `bun test apps/mobile`
  then `3580 pass · 0 fail`. The skips are the pre-existing opt-in ones (this
  diff adds no skip).
- e2e (iOS 26.5, iPhone 17 Pro Max 0B43D716…, harness ephemeral ports):
  - `28-floating-activity` ✓.
  - `33-hub`: the fresh install reads Floating at **80 %** with the five
    marks, shot `33-hub-opacity-band-80-{light,dark}.png`, and the left-end
    drag reads 20 % (`33-hub-opacity-band-*`) — copied to
    `.tentacle/tmp/mobile-hub-defaults/`. Final run (4th; runs 1–3 stopped at the
    below-the-fold slider, an XCUITest disconnect, and the scrolled-away back
    button — each fixed in the flow or infra): every Settings step passes and the
    session shows `floating-activity` at 20 %, then ✗ at `assertVisible id:
    hub-glyph` — the hierarchy has `floating-activity` as ONE accessibility
    element, with no `hub-glyph` child, although the glyph is drawn on screen.
    `FloatingActivity.tsx` is untouched by this diff, so this is not caused by
    the opacity or default change; unverified whether it also fails on `main`
    (follow-up: run flow 33 on `main`, or assert on `floating-activity` only).
  - `27-activity` ✗ twice, the SAME way, AFTER this branch's new steps pass
    (Header picked, the header pill opens the sheet): `tapOn text: "long
    child"` finds nothing because the row is ONE accessibility element
    (`accessibilityText: "long child, sa-1 · general · 13 steps · 27s"`), and
    Maestro's text match is a full regex. `ActivityRow.tsx` is untouched here
    (last change `e8ed1c62`, feat/mobile-activity-panel), so this predates
    the branch; not fixed here (out of scope) — follow-up: match
    `long child.*` or the row's testID.

## Review

*— claude-opus-5-5, 2026-11-18* (fresh context, SAME model as the executor:
shared blind spots possible; acceptable for `contained`, S)

**Verdict: APPROVE** — no HIGH/MEDIUM findings.

- **Gate (scoped):** the 4 touched test files `108 pass · 0 fail`; `bun run lint`
  clean (2084 files); `bun run typecheck` (root + mobile + relay) clean. Full
  `bun test` not re-run by this review.
- **Load-bearing premise TRUE:** `parse` / `read` (`activity-settings-store.ts`)
  return `DEFAULT_ACTIVITY_SETTINGS` only for missing / unreadable / unknown-`v`
  / a throwing `kv.get`; a readable record is never merged with it, so a stored
  `"header"` stays and a stored record without `opacity` stays 100 %.
- **Mutations (all caught, reverted, tree byte-clean):** ties DOWN in
  `snapOpacity` → 3 fails (snap, opacityAt bands, store snap); haptic AFTER
  `dragged.current = next` → steps-wiring fail; default back to `"header"` →
  2 store fails.
- **Attacks tried:** (1) off-step 35 then a drag that ends on 40 → `commit`
  compares against the snapped `committedValue`, no write — matches decision 3;
  (2) grant on the held released value → `dragged` is null after `commit`, so
  the grant compares against `shownNow`, no spurious tick; (3) ±∞ / NaN →
  100 / 20 / 20, never invisible; (4) other `clampOpacity` callers → none left;
  (5) a throwing Keychain read now shows the floating hub (not Header) with the
  setting disabled — a transient read failure overrides a stored Header for that
  run. Covered by the doc's "unreadable → defaults" failure mode; the hub is
  still a usable entry point, so noted, not a finding.
- **Not verified here:** e2e flows 27/33 (the executor's two e2e failures are
  attributed to untouched components but not checked on `main` — run flow 33
  on `main` before merge to confirm).
- **Executor behaviour:** red-first tests shown, drift recorded honestly
  (source pin rename, below-the-fold scroll), e2e failures reported rather
  than hidden.
