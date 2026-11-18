# feat/mobile-hub-badges — Hub without badge dots/bubbles; solid fan discs

> **Status:** implementation (awaiting owner answers + approval)
> **Branch:** `feat/mobile-hub-badges`
> **Size:** M · **Blast:** contained · **Suited:** owner assigns (contained M → standard Review)
> **Changelog:** `changelog.d/mobile-hub-badges.changed.md`

## Context

*— claude-opus-5-5, 2026-11-18*

Owner, 2026-11-17: the accent DOT on the hub button and the NUMBER bubble ("6")
on fan items are "antiestetico", "bruttissimo"; and with the fan open,
transcript text bleeds through the translucent glass items. Mockups were picked
on 17/11 (recorded in `TODO.md` — the mockup README itself is no longer on disk):

- **Q1 C** — the button's "something new" signal becomes a **one-shot glow +
  haptic** when it arrives; no persistent dot.
- **Q2 C** — a fan item's count becomes a **rim arc whose length ∝ the count**;
  no bubble.
- **Q3 B** — fan items become **solid (opaque) discs**; no blur, no vignette.

Sequencing: `feat/mobile-hub-tap` is merged (`e6dcdd5c`) and left the dimmed
item as an opacity placeholder for this task (`HubFan.tsx:41-45`, `:111-118`).
`feat/mobile-hub-native-driver` (same file, not merged) is listed in `TODO.md`
as "before hub-badges" (see Owner question 5).

**Repro (static evidence, current `main` = `dc8771ef`, 2026-11-18):** this is a
visual feat, so the "missing capability" is the presence of the elements to
remove, cited rather than scripted:
- button dot: `FloatingActivity.tsx:506-512` (`testID="hub-badge-dot"`, a 9 pt
  `accentFill` circle at top-right), fed by `buttonBadge` → `{kind:"dot"}`
  (`hub-actions.ts:257-258`) when `unseenArtifacts > 0 || unreadReport`.
- item bubble: `HubFan.tsx:146-157` (12 pt `accentFill` pill with `item.badge.n`).
- translucent items: item `backgroundColor: palette.glass` (`HubFan.tsx:137`) =
  `rgba(255,255,255,0.82)` light / `rgba(40,41,44,0.86)` dark (`theme.ts:108`,
  `:154`); the label pill is glass too (`HubFan.tsx:174`).
The executor confirms these lines on the branch before any edit.

## Implementation

*— claude-opus-5-5, 2026-11-18*

### Load-bearing assumption

**The item's MEANING (`HubBadge` count/dot) can stay as it is in
`hub-actions.ts`; only its PROJECTION to pixels changes.** Badge promotion
(`hub-actions.ts:168-173`) and every existing ordering test key on
`badge !== null`, not on how it is drawn — so replacing the bubble with a rim
changes no order, no commit and no snapshot logic. Verified: the only renderers
of `item.badge` are `HubFan.tsx:146-157`; the only consumer of `buttonBadge` is
`SessionScreen.tsx:1301` (grep `buttonBadge|\.badge\b` over `apps/mobile/src`).

### Preconditions

- An arc of any fraction can be drawn with plain `View`s, no SVG/native rebuild:
  `ringArcs` / `ringHalfRotation` (`chat-header.ts:108-113`, `:149-151`) +
  `HalfRing` (`ContextRing.tsx:86-113`). Today its geometry is hard-wired to
  `RING = 20`, `STROKE = 1.8` (`ContextRing.tsx:31-32`, styles `:122-136`).
- `palette.card` and `palette.fill` are opaque in both palettes (`theme.ts:86,
  91, 129, 134`); `palette.sec` is the secondary label colour (`:95`, `:138`).
- The hub's haptics go through `HapticKind` (`haptic-rules.ts:13`) and
  `playHaptic`; the turn-end `success` fires from a `useEffect` on
  `composer.running` (`SessionScreen.tsx:776-780`).
- New artifacts typically land at a turn's end, i.e. the same moment as that
  `success` haptic (failure mode F4).
- `hubA11yLabel` already speaks "N new artifacts" / "unread report"
  (`hub-actions.ts:264-277`): removing the dot loses no VoiceOver information.
- The arc on the button (`FloatingActivity.tsx:514-546`) is the body's sibling,
  so it follows the outer fade but not the rest-opacity setting — the glow sits
  in the same place for the same reason.

### Design

Pure logic first (AGENTS §7), components only render the result.

1. **Button: drop the dot, keep the running count** (`hub-actions.ts`).
   `buttonBadge` returns `{kind:"count", n}` or `null` — the `unseenArtifacts ||
   unreadReport` → dot branch goes. Its return type narrows to
   `ButtonCount = { kind: "count"; n: number } | null`. `hubA11yLabel` is unchanged.
2. **Button: one-shot pulse** (`hub-actions.ts`, new pure fn):
   ```ts
   export interface PulseInput { readonly unseenArtifacts: number; readonly unreadReport: boolean }
   export function hubPulse(prev: PulseInput | null, next: PulseInput): boolean
   ```
   True iff `prev !== null` and (`next.unseenArtifacts > prev.unseenArtifacts`
   or `!prev.unreadReport && next.unreadReport`). `prev === null` (first render
   of a session) → false (Owner question 3). A decrease, or an equal value, → false.
3. **Pulse haptic** (`haptic-rules.ts`, new pure fn):
   `pulseHaptic(pulse: boolean, turnEnded: boolean): HapticKind | null` →
   `"light"` iff `pulse && !turnEnded` (one haptic per moment, Owner question 4).
   The screen computes `turnEnded` with the existing `turnEndHaptic(...) !== null`
   in the SAME effect, so the two decisions see the same render.
4. **Screen wiring** (`SessionScreen.tsx`). A `useRef<PulseInput | null>` holds
   the previous input; it is reset to `null` when the session uid changes. One
   effect (merged with the turn-end one at `:776-780`) computes `pulse`, plays
   `turnEndHaptic` and `pulseHaptic`, and on `pulse && floatShown` increments a
   `pulseSeq` state passed to `FloatingActivity` as `pulse: number`.
5. **Glow** (`FloatingActivity.tsx`). The `badge` prop becomes
   `count: number | null`; the `hub-badge-dot` block (`:506-512`) and the
   `newDot` style (`:609`) are deleted. New sibling of the body, beside the arc:
   an `accent` ring (`borderWidth: 2`, `FLOAT_SIZE` + 8) with
   `testID="hub-glow"`, driven by ONE `Animated.Value`: on a `pulse` change
   (skip the first mount) it runs 0→1→0 over ~700 ms, mapped to opacity
   0→0.9→0 and scale 1→1.18, `useNativeDriver: true`. With Reduce Motion, opacity
   only (no scale). It is mounted only while the animation runs (or kept at
   opacity 0 — executor's choice, `pointerEvents="none"` either way).
6. **Rim arc on fan items** (`hub-fan.ts`, new pure fn + constant):
   ```ts
   export const RIM_FULL = 5;
   export function rimFraction(badge: HubBadge | null): number | null
   ```
   `null` → `null`; `{kind:"count", n}` → `min(max(n,0), RIM_FULL) / RIM_FULL`
   (n ≤ 0 → `null`); `{kind:"dot"}` (scheduled due) → `1` (Owner question 2).
7. **Item look** (`hub-fan.ts`, new pure fn, colours as palette KEYS so it stays
   presentation-free of hex values):
   ```ts
   export interface FanItemLook {
     readonly bg: "card" | "fill" | "accentFill" | "red";
     readonly fg: "accent" | "red" | "onAccent" | "sec";
     readonly rim: number | null;          // 0–1, from rimFraction
     readonly rimTone: "accent" | "onAccent";
   }
   export function fanItemLook(item: HubItem, lit: boolean): FanItemLook
   ```
   Lit: `bg` `red` (danger) or `accentFill`, `fg` `onAccent`, `rimTone`
   `onAccent`. Not lit: `bg` `card`, `fg` `red`/`accent`; dimmed not lit: `bg`
   `fill`, `fg` `sec` — this REPLACES `DIMMED_OPACITY` (`HubFan.tsx:45`) and the
   `Animated.multiply` (`:118`), so the item's opacity is again just its
   spring/fade/highlight value. `glass` is never returned (Q3 B).
8. **Shared ring renderer** (`ui/RingArc.tsx`, new). `HalfRing` and its styles
   move out of `ContextRing.tsx` into `RingArc({ diameter, stroke, fraction,
   tone, track? })`, which uses `ringArcs(fraction*100)` + `ringHalfRotation`.
   `ContextRing` renders `<RingArc diameter={20} stroke={1.8} … track={sep} />`
   (pixel-identical: same numbers). `ringArcs`'s orange tone is ignored for the
   rim (the caller passes `tone`).
9. **HubFan** renders `fanItemLook`: `backgroundColor: palette[look.bg]`, the
   glyph in `palette[look.fg]`, and when `look.rim !== null` a
   `<RingArc diameter={ITEM_SIZE} stroke={2} fraction={look.rim}
   tone={palette[look.rimTone]} />` absolutely positioned over the item (no
   track). The bubble (`:146-157`) and `styles.badge`/`badgeText` go. The
   label pill's `backgroundColor` becomes `palette.card` (it bled too). The
   scrim stays as is (no blur/vignette, Q3 B).
10. **Item VoiceOver label** (`hub-actions.ts`, new pure fn
    `itemA11yLabel(item)`): the bubble was visual-only, so the rim must be
    spoken: `"Artifacts, 3 new"`, `"Scheduled, due soon"`, dimmed `"Activity,
    nothing running"` (today's string, moved from `HubFan.tsx:125`), else the
    label. HubFan uses it.

### Files

1. `apps/mobile/src/hub-actions.ts` — `buttonBadge` narrowed, `hubPulse`,
   `itemA11yLabel`.
2. `apps/mobile/src/haptic-rules.ts` — `pulseHaptic`.
3. `apps/mobile/src/hub-fan.ts` — `RIM_FULL`, `rimFraction`, `fanItemLook`.
4. `apps/mobile/src/ui/RingArc.tsx` (new) + `apps/mobile/src/ui/ContextRing.tsx`
   (uses it).
5. `apps/mobile/src/ui/HubFan.tsx` — solid discs, rim, label pill, a11y label.
6. `apps/mobile/src/ui/FloatingActivity.tsx` — `count` prop, dot removed, glow.
7. `apps/mobile/src/screens/SessionScreen.tsx` — pulse ref/effect, props.
8. Tests: `apps/mobile/test/hub-actions.test.ts`, `hub-session.test.ts`
   (`:166-167`), `haptic-rules` test (existing file if any, else
   `test/haptic-rules.test.ts`), `hub-fan` test, and whichever render test
   asserts `hub-badge-dot` / `hub-badge-count` (grep the testIDs).
9. `changelog.d/mobile-hub-badges.changed.md` — one bullet.

No protocol, daemon, client or persistence change.

### Failure modes

- **F1 Resume / session switch with unseen > 0.** `prev` is `null` → no pulse,
  no haptic. The rim on Artifacts and the VoiceOver label still carry it.
  Converges: the next real increase pulses.
- **F2 Reconnect / resync recomputes the count.** `unseenArtifacts` is derived
  from the list + this device's seen record (`hub-session.ts:67-74`); a resync
  that relists the same artifacts yields the same number → no pulse. A list
  that briefly empties (`undefined` → 0) and refills WOULD pulse on the refill.
  Guard: `hubPulse` is fed only while `link === "up"`, and `prev` is reset to
  `null` on a link drop, so the refill after reconnect is a fresh baseline.
- **F3 Button hidden (`shown === false`, keyboard up).** No glow, no haptic,
  not deferred (a deferred glow would be stale). `prev` still advances.
- **F4 Artifact lands with the turn end.** Same effect, `turnEnded` true → only
  `success` plays; the glow still runs. Never two haptics at once.
- **F5 Two increases inside one glow.** `pulseSeq` bumps again; the effect
  `stop()`s the running animation and restarts from 0 (one glow visible, never
  stacked rings).
- **F6 Fan open when it pulses.** The glow is a child of the button, so it is
  layered exactly like the button over the fan; it plays. The haptic follows
  F3/F4. The open fan's layout is a snapshot (`hub-actions.ts:186-199`), so the
  Artifacts rim updates only at the next open — unchanged behaviour.
- **F7 Huge or empty counts.** `rimFraction` clamps at `RIM_FULL`; n ≤ 0 →
  `null` (counts are lengths, so never NaN).
- **F8 Reduce Transparency.** Discs are already opaque; no change needed. The
  body of the button keeps `hub-opacity.ts` behaviour (untouched).
- **F9 Rim vs highlight.** Lit item bg `accentFill` + rim `onAccent`, so the rim
  never disappears into its own disc.

### Tests

Red-before-green: each new/changed assertion is run against `main`'s code first
(it fails: function missing, or the dot still returned) — paste the red in
Execution.

- `hub-actions.test.ts`: `buttonBadge` returns the count when running and
  **`null` for unseen/unread** (replaces `:337-338`); `hubPulse` — null prev →
  false; artifacts 2→3 → true; 3→2 → false; 3→3 → false; unread false→true →
  true; true→true → false; `itemA11yLabel` for count, dot, dimmed, plain.
- `hub-session.test.ts:166-167`: expectation becomes `null` (no dot).
- `haptic-rules` test: `pulseHaptic(true,false)` = `"light"`;
  `(true,true)` = `null`; `(false,*)` = `null`.
- `hub-fan` test: `rimFraction` — null, `count 0` → null, 1 → 0.2, 5 → 1,
  99 → 1, dot → 1. `fanItemLook` — **no input returns `bg: "glass"`** (iterate
  every combination of danger/dimmed/lit/badge); dimmed not lit → `fill`/`sec`;
  lit danger → `red`/`onAccent`; lit with rim → `rimTone: "onAccent"`.
- `theme` property: `card` and `fill` are `#RRGGBB` (opaque) in both palettes —
  pins the Q3 B premise against a future token change.
- Render test (the file that holds the hub's `testID`s): no `hub-badge-dot`
  ever renders; `hub-glow` appears after the `pulse` prop changes and not on
  first mount.
- Non-vacuity (§9): temporarily make `fanItemLook` return `glass` for one case,
  and `hubPulse` return true on `prev === null`; both suites must fail.
- Manual (simulator, owner's eye): light + dark, the fan over a dense
  transcript (no bleed), a pulse at turn end (one haptic), Reduce Motion.

### Owner questions

1. **Running count on the button**: the owner named only the DOT; keep the
   running number that replaces the glyph (`FloatingActivity.tsx:490-498`)? —
   *Rec: keep* (it is not a bubble, and it is the only at-rest running signal).
2. **Rim scale**: full rim at `RIM_FULL = 5` (1 → 20 %), and a scheduled wake
   that is due draws a full rim? — *Rec: yes to both.*
3. **Pulse on resume**: opening a session that already has unseen artifacts —
   glow or not? — *Rec: no; only an increase seen live pulses (F1).*
4. **Haptic**: pulse haptic `light`, dropped when the turn-end `success` fires
   in the same moment? — *Rec: yes, one haptic per moment (F4).*
5. **Order vs `feat/mobile-hub-native-driver`** (same file, TODO says it goes
   first): — *Rec: honour it; badges executes after native-driver merges (the
   glow is native-driven anyway, so the rebase is small).*

#### Orchestrator decisions (2026-11-18 05:12, owner delegated the night)
- The mockups README DOES exist: /Users/gmeghnag/tentacle/.tentacle/mockups/mobile-hub-badges/README.md ("## CHOSEN"); the executor reads it.
- Q1 keep the running number on the button (rec). Q2 CORRECTED to the owner-picked mockup: **36° per item** (C · "Rim arc ∝ count: 36° per item"), full rim at 10, a due scheduled wake draws a full rim. Q3 no pulse on resume (rec). Q4 one haptic per moment (rec). Q5 execute after feat/mobile-hub-native-driver merges, re-verify file:line (rec).
- Implementation APPROVED.
*— claude-opus-5-5 (orchestrator), 2026-11-18*

## Review

*— claude-opus-5-5, 2026-11-18* (fresh context; same model family as the planner, different from the deepseek executor)

**Verdict: REQUEST-CHANGES.** Gate is red.

1. **HIGH — test red.** `apps/mobile/test/hub-badges-wiring.test.ts` "no glow while the button is hidden (F3)" expects `pulsePrev.current = newsNow`; `SessionScreen.tsx:975` writes an object literal instead (`newsNow` computed at :952 is then only read for `unseen`/`unread`). Touched files: 163 pass / 1 fail.
2. **HIGH — lint red (baseline is 0).** `SessionScreen.tsx:965` `useExhaustiveDependencies` (the `[artifactsSeenKey]` effect never reads its dep) + format of `SessionScreen.tsx:974`. `bun run check` cannot be green. Typecheck passes.
3. **MEDIUM — F2 guard is dead code.** The link-drop reset effect (`SessionScreen.tsx:960-963`) runs before the main effect (:968-980) in the same commit, and the main effect also depends on `linkUp`, so it immediately overwrites `pulsePrev` with the link-down reading: the baseline is never `null` on reconnect, and is advanced during the outage — contrary to Design F2 ("fed only while link up; prev reset on drop"). A drop-time empty list (0) then a refill after reconnect pulses spuriously. The wiring test's "≥2 `pulsePrev.current = null`" counts text, not behaviour (vacuous for this property).
4. **MEDIUM — F1 reset can swallow the next real pulse.** The `artifactsSeenKey` reset (:964-967) is a separate effect; if the switch leaves `unseen/unread/linkUp/floatShown/running` unchanged, the main effect doesn't run, `prev` stays `null`, and the next genuine increase compares against `null` → no glow (F1 says "the next real increase pulses").
5. **MEDIUM — no Execution section.** No as-built, no red-before-green evidence, no mutation record (§9/§10). Plan Tests also asked for a `theme` opacity property test (card/fill `#RRGGBB`) — not present on the branch.

Attacks tried: haptic F4 (one effect, `ended !== null`) — holds; `rimFraction` clamp/NaN/≤0 — holds; `fanItemLook` never `glass` — holds; ContextRing pixel parity (20/1.8, track `sep`) — holds; glow on native driver (opacity + transform only) — holds. Mutation not run beyond reading: the gate is already red, so non-vacuity is moot until fixed.
