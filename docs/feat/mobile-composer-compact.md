# feat/mobile-composer-compact — the empty composer rests on ONE row

> **Status:** implementation (APPROVED) · execution · review · done
> **Branch:** `feat/mobile-composer-compact`
> **Size:** M · **Blast:** contained · **Suited:** DeepSeek executes (plan by Opus); standard Review + the e2e flow 23 on a simulator before merge
> **Changelog:** `changelog.d/mobile-composer-compact.changed.md`

Type: feat · Size: M · Blast: contained · Suited: Opus mockups + plan → DeepSeek exec · standard Review

## Context

*— claude-opus-5-5, 2026-11-26*

**The problem.** On the iPhone the chat's composer is always two rows: the
`TextInput` on top and the 36 pt button row under it, even when it is empty and
nobody is typing (`apps/mobile/src/ui/Composer.tsx:230` the input, `:249` the
row, both unconditional). At rest that is an 82 pt field whose top line holds
only the hint «Message tentacle», and whose send slot draws a dimmed ↑ that does
nothing (`Composer.tsx:328-367`, face `up-dim` from `sendSlot`,
`apps/mobile/src/composer.ts:149-161`). The owner asked (2026-11-23 ~11:15) for
the empty composer at rest to be ONE row, opening to today's two rows only when
the field is tapped.

**Owner decisions (2026-11-23 ~11:55, on the mockup v2
`https://claude.ai/artifact/LMeMREwnkcGAtxYXKTixnv`, source
`.tentacle/mockups/composer-hub/index.html` §1) — recorded, not reopened:**

- **OD1 — one row at rest.** Empty and untouched, the composer is one row: the
  hint «Message tentacle» sits on the buttons' row (`+` · hint · mic). Tapping
  the field opens today's two rows.
- **OD2 — 1a B: no ↑ at rest.** The dimmed ↑ is not drawn on the resting row.
  The slot comes back whenever it IS an action: ■ Stop while a turn runs, ↑ once
  there is a draft.
- **OD3 — 1b A: stays open while it holds something.** With the keyboard down,
  a field that holds text, an attachment or a dictation stays open (two rows);
  only an EMPTY field closes back to one row.

**Orchestrator decisions** (the details the owner did not decide; each the
recommended option):

- **D1 — "holds something" is exactly:** a draft that is not `""` (whitespace
  counts: it is the person's text, and `composer-filled` already treats any
  non-`""` draft as filled, `Composer.tsx:371`), ANY attachment chip whatever
  its state (uploading, refused…: it is on screen above the field), a dictation
  in any non-idle mic state (`preparing` — asking permission or downloading the
  model — `listening`, `finalizing`; `dictation.ts:183-200`), or a pending
  message being edited (`compose.editing`, the "Editing pending message" banner,
  `SessionScreen.tsx:2338-2357`). Open = focused OR holds something.
- **D2 — open = today, unchanged.** The open shape is pixel-identical to
  today's composer, the dimmed ↑ included (OD2 is about the resting row only).
  Only the compact shape is new.
- **D3 — ■ Stop does not open the field** (the mockup's rule, 1c "turn running"):
  it sits on the compact row in the slot.
- **D4 — Send now while compact: the pill stays, the hint goes.** While a turn
  runs and a message of mine is queued, `sendNowOffered` (`composer.ts:131-136`)
  draws the ⇥ Send now pill on the row (`Composer.tsx:268-284`). On a compact
  row `+` · pill · mic · ■ leave ~115 pt of text on a 402 pt phone (field inner
  360 − input start 40 − 10 pad − cluster 185 − 10 pad) for a hint that needs
  ~128 pt at 17 pt: a multiline placeholder would wrap and grow the row. So the
  compact row keeps the pill (an action) and shows NO hint (`""`). The row stays
  compact (OD3 does not apply: nothing is in the field) and a tap on it opens the
  field as always. Rejected: hiding the pill (removes a control the owner did not
  ask to remove — it is also in the bubble's E1 menu, `PendingBubble.tsx:32`,
  but the pill is the one-tap path), and opening the field (contradicts the v2
  figure "turn running + queued message: the row stays closed").
- **D5 — dictation started from compact opens the field but not the keyboard**
  (mockup v2 rule; follows from D1: the mic is a `Pressable`, it never takes the
  field's focus).
- **D6 — motion: reuse the app's one layout animation.**
  `animateNextLayout(reduceMotion)` (`apps/mobile/src/ui/animate.ts:10-15`,
  native ease-in-out; a no-op under Reduce Motion) is called right before a
  focus/blur-driven shape change and before a mic tap from compact. No new
  timing constant (the v2 proposal of a `COMPOSER_EXPAND_MS` is not needed:
  `LayoutAnimation` keeps the native curve, and `test/motion-literals.test.ts`
  stays untouched). Shape changes driven by props alone (a send empties the
  field, a chip arrives) land with whatever layout animation that change already
  has.
- **D7 — the kit learns the compact composer** in this task: `K.composer`
  gains `compact` (the «nuovo» `composerShape` extension of the mockup becomes
  the kit's), so later mockups draw the real resting state.

**Mockup (final, the chosen design + today for comparison):**
`.tentacle/mockups/mobile-composer-compact/index.html` → snapshot
`index.inline.html` (kit main d80656f4). Variant 1 "Oggi"; variant 2 "Scelta"
in seven states (rest · tapped · draft with keyboard down · attachment only ·
dictation from rest · turn running · turn running + queued), each light and
dark (petrol/graphite switch). It also reports two kit drifts (§ "Il kit da
correggere": `.k-send-now` background/font vs `Composer.tsx:277/282`).
Rendered by the planner without a browser (headless Chrome was not permitted in
this session): the snapshot's pixels are unverified until opened.

**Repro** (2026-11-26, worktree at main d80656f4;
`.tentacle/tmp/mobile-composer-compact/rest-height.ts`, reads the generated kit
tokens — `scripts/mockup-kit.ts gen` derives them from `Composer.tsx`'s
`StyleSheet` and `theme.ts` — and the Composer source):

```ts
import { readFileSync } from "node:fs";

const root = `${import.meta.dir}/../../worktrees/mobile-composer-compact`;
const css = readFileSync(`${root}/tools/mockup-kit/generated/tokens.css`, "utf8");
const src = readFileSync(`${root}/apps/mobile/src/ui/Composer.tsx`, "utf8");
const px = (name: string): number => {
  const m = new RegExp(`--${name}: (\\d+)px`).exec(css);
  if (m === null) throw new Error(`no token ${name}`);
  return Number(m[1]);
};
const border = 2 * px("m-composer-field-border-width");
const input = px("m-composer-input-padding-top") + px("t-body-lh") + px("m-composer-input-padding-bottom");
const rest = px("m-composer-field-padding-top") + input + px("m-composer-row-height") + px("m-composer-field-padding-bottom") + border;
console.log(`rest field height: ${rest} pt (input line ${input} + row ${px("m-composer-row-height")})`);
console.log(`size.composer token: ${px("s-composer")} pt`);
console.log(`TextInput always above the row: ${src.indexOf("<TextInput") < src.indexOf("<View style={styles.row}>")}`);
console.log(`send slot rendered unconditionally: ${/\n {10}<Pressable\n {12}testID=\{testIdOf\(button\)\}/.test(src)}`);
console.log(`any compact/shape branch: ${/compact|composerShape/.test(src)}`);
```

```
$ bun .tentacle/tmp/mobile-composer-compact/rest-height.ts
rest field height: 82 pt (input line 34 + row 36)
size.composer token: 48 pt
TextInput always above the row: true
send slot rendered unconditionally: true
any compact/shape branch: false
```

The executor re-runs it on `main` before any edit (the path is relative to the
worktree; adjust `root` if run elsewhere). After the change the observable is
flow 23's shot `23-keyboard-closed` (one row) and its new asserts (Tests §e2e).

## Implementation

*— claude-opus-5-5, 2026-11-26*

**APPROVED** (planner, on the owner's decisions OD1–OD3 and the orchestrator
decisions D1–D7 above; 2026-11-26).

### Load-bearing assumption

**Changing the shape never remounts or blurs the `TextInput`.** The tap that
opens the field IS the native focus of the input (no programmatic re-focus), and
the keyboard comes up for that same input; if the compact → open re-layout
remounted the input, or removed and re-inserted its native view, the first
responder would be lost: the keyboard would drop and the typed text go nowhere.

How the design guarantees it (all React/RN facts, the last proven on device):

1. The `TextInput` is the **first child of one container in BOTH shapes**, and
   no element is ever mounted or unmounted BEFORE it. Both shapes render the same
   ordered children `[TextInput, +, spacer, Send now?, caption?, mic?, slot?]`;
   only `style` differs. A style change on the same host element at the same
   position is a prop update, never a remount (React reconciliation: same type +
   same position ⇒ same fiber; the input already keeps `key={fieldKey}`,
   `Composer.tsx:231`, which changes only on a send).
2. The only children that mount/unmount (the pill, the caption, the mic, the
   slot) all come AFTER the input, so the input's native index never shifts.
3. **Proof by execution (the falsifier):** flow 23's new first steps tap
   `composer-input` on the COMPACT field and `inputText`; `composer-filled`
   becomes visible only if the keystrokes reached the field that just reshaped
   (Tests §e2e). If (1)/(2) did not hold, that assert is red.

Today's code confirms the starting point: the input and the row are two separate
children of the field (`Composer.tsx:219-376`: `<TextInput>` at `:230`, the row
`<View style={styles.row}>` at `:249`), so "putting the input on the row" is NOT
possible by moving it into the row view (a re-parent = a remount). Hence the
single wrapping container below.

### Preconditions

- **Logic in pure modules (AGENTS §7).** The composer already follows it:
  `composer.ts` is React-free (`composerAction`, `sendSlot`,
  `composer.ts:75-161`), the view-model computes the slot
  (`session-view.ts:489`), and `Composer.tsx` only draws `slot`
  (`Composer.tsx:31,48`). The new shape rule joins `composer.ts`'s family as
  its own pure module.
- **What the component already receives.** `draft`, `mic`, `slot`, `sendNow`,
  `placeholder`, `fieldKey`, `focus`, `focusKey` (`Composer.tsx:41-74`), wired at
  `SessionScreen.tsx:2413-2456`. The chips (`compose.chips`,
  `SessionScreen.tsx:2378`) and the edit state (`compose.editing`,
  `SessionScreen.tsx:2338`) are NOT passed yet — two new props.
- **The send remounts the field and drops the keyboard.** `fieldKey={state.sends}`
  (`SessionScreen.tsx:2415`) remounts the input after each send
  (`Composer.tsx:64-69`), and `Keyboard.dismiss()` runs on every send
  (`SessionScreen.tsx:791-795`). A remounted input does not reliably fire
  `onBlur` for the old one ⇒ the focus flag must be keyed by `fieldKey` (Design).
- **Programmatic focus paths exist and go through the input's own focus:** the
  first-editable focus (`Composer.tsx:203-208`) and the hub's Steer `focusKey`
  (`Composer.tsx:209-213`). Both call `input.current?.focus()` ⇒ `onFocus` fires
  ⇒ open. No extra wiring.
- **The resting height is already a token.** `size.composer: 48`
  (`apps/mobile/src/theme.ts:427`) — and compact = 4 + 36 + 6 + 2 border = 48
  (`Composer.tsx:383-392` paddings and row height). `CopyFlash` already
  positions itself from `size.composer` (`apps/mobile/src/ui/CopyFlash.tsx:80`),
  so it gets MORE right at rest, not less.
- **The composer's height already changes at runtime today**: a wrapping draft
  grows the input up to `maxHeight: 132` (`Composer.tsx:391`). The list's
  response to a composer height change (follow / jump, `follow.ts`) is an
  existing, exercised path; this task adds one more height change of the same
  kind, not a new class.
- **The one layout animation:** `animateNextLayout(reduceMotion)`
  (`ui/animate.ts:10-15`); the Reduce Motion hook is already imported in the
  component (`Composer.tsx:37`, `useReduceMotion() !== false` at `:103`).
- **The kit reads `Composer.tsx`'s styles** (`scripts/mockup-kit/manifest.ts:20`,
  `styles: true`) into `tools/mockup-kit/generated/tokens.css`
  (`--m-composer-*`), and `kit.css` uses those vars (`.k-composer-row` reads
  `--m-composer-row-height`, `tools/mockup-kit/kit.css:429-435`). Renaming or
  dropping a style changes the generated tokens ⇒ `bun run mockup-kit` and the
  kit's drift test are part of this task.
- **Flows depend on the composer ids** (`composer-input`, `composer-send`,
  `composer-stop`, `composer-mic`, `composer-photo`, `composer-filled`,
  `composer-send-now`; pinned by `apps/mobile/test/composer-field-layout.test.ts:47-60`).
  Every existing flow that taps `composer-send` does so AFTER `inputText`
  (e.g. `apps/mobile/e2e/flows/23-composer-keyboard.yaml:36-44`,
  `11-disconnect-mid-turn.yaml:49-56` — after `hideKeyboard`, the draft keeps the
  field open, OD3), so the slot they tap is never the hidden resting one.

### Design

**1. Pure module — `apps/mobile/src/composer-shape.ts`** (React-free, no RN
import; types only from `composer.ts` and `dictation.ts`):

```ts
export type ComposerShape = "compact" | "open";

export interface ComposerShapeInput {
  /** The field has the focus (the component's onFocus/onBlur, keyed by fieldKey). */
  readonly focused: boolean;
  readonly draft: string;
  /** Attachment chips on screen, any state. */
  readonly attachments: number;
  readonly mic: MicButton;
  /** A pending message is being edited (the banner above the field). */
  readonly editing: boolean;
  /** The slot's face (`sendSlot`). */
  readonly slot: SendSlot;
  /** Send now is offered (`sendNowOffered`). */
  readonly sendNow: boolean;
  /** The hint the screen would show (`SessionScreen` placeholder chain). */
  readonly placeholder: string;
}

export interface ComposerShapeView {
  readonly shape: ComposerShape;
  /** Draw the send slot? false only for the dimmed ↑ on a compact row (OD2). */
  readonly slotShown: boolean;
  /** The hint to draw: "" on a compact row that carries the Send now pill (D4). */
  readonly placeholder: string;
}

/** Whether the field holds something that keeps it open (OD3, D1). */
export function composerHolds(input: Pick<ComposerShapeInput, "draft" | "attachments" | "mic" | "editing">): boolean;

export function composerShape(input: ComposerShapeInput): ComposerShapeView;
```

Rules (the whole truth table, each line a test):

| focused | holds (D1) | shape | slotShown | placeholder |
|---|---|---|---|---|
| true | any | open | true (today, `up-dim` included — D2) | as given |
| false | true | open (OD3) | true | as given |
| false | false | compact (OD1) | `slot !== "up-dim"` (OD2: ■ / ↑ / clock stay) | `sendNow ? "" : given` (D4) |

`holds = draft !== "" || attachments > 0 || mic ∈ {preparing, listening,
finalizing} || editing`. `mic: "hidden"` and `"idle"` do not hold.

**2. Component — `apps/mobile/src/ui/Composer.tsx`** (presentation only):

- New props: `attachments: number`, `editing: boolean`.
- Focus flag, keyed by the field: `const [focus, setFocus] = useState({ key:
  fieldKey, on: false })`; `focused = focus.key === fieldKey && focus.on`.
  `TextInput` gets `onFocus` / `onBlur` that call `animateNextLayout(reduce)`
  then `setFocus({ key: fieldKey, on: true|false })`. (The existing `focused`
  ref at `Composer.tsx:202` is for the first-focus effect: rename one of the two
  so they do not collide.)
- `const view = composerShape({ focused, draft, attachments, mic, editing,
  slot, sendNow, placeholder })`; the component branches only on `view.*`.
- Mic tap from compact: the mic's `onPress` calls `animateNextLayout(reduce)`
  when `view.shape === "compact"`, then `onMic()` (D5/D6).
- **Layout — one wrapping body** replaces the input + `row` pair inside the
  field: a `View` with `flexDirection: "row"`, `flexWrap: "wrap"`,
  `alignItems: "center"`, `gap: 4`, `paddingHorizontal: 2` (today's row gap and
  padding, `Composer.tsx:392`). Children, in this fixed order in BOTH shapes:
  1. the `TextInput` (always first — the load-bearing rule),
  2. the `+` pressable,
  3. a spacer `View`,
  4. the Send now pill (if offered), 5. the mic caption, 6. the mic, 7. the slot
     (only if `view.slotShown`).
  - **open** (today's geometry, pixel-identical): input `width: "100%"` with
    `marginHorizontal: -2` (cancels the body padding: text stays 16 pt from the
    field's border as today) and today's `input` paddings; it takes the first
    line, everything else wraps to the second line, where `+` is in flow at
    the left, the spacer has `flex: 1`, and the hit targets keep
    `marginVertical: -4` so the line is 36 pt as today.
  - **compact**: the input `flex: 1`, `marginLeft: 38` (44 hit + 4 gap − 10
    input padding: the hint starts 50 pt in, the mockup's geometry), paddings
    centring one 22 pt line in 36 pt (`paddingTop: 7, paddingBottom: 7`); the
    `+` is `position: "absolute"`, `left: 2`, `top: -4` (its 44 pt hit centred on
    the 36 pt line); the spacer gets `display: "none"` (a style, not an unmount:
    Yoga skips it, so it adds no `gap` either — a `width: 0` spacer would still
    take two 4 pt gaps). Field height =
    4 + 36 + 6 + 2 = 48 = `size.composer`.
  - Style names: keep `row` meaning "the 36 pt line" for the kit (`kit.css`
    reads `--m-composer-row-*`) — e.g. the body is `styles.body`, the compact
    input `styles.inputCompact`, the absolute `+` `styles.plusCompact`. Whatever
    the names, regenerate the kit and keep `kit.css` consistent (Files).
- **Observable:** a 1×1 hidden `Text` `testID="composer-compact"` while
  `view.shape === "compact"`, same style and reason as `composer-filled`
  (`Composer.tsx:369-375`, `:440-448`: Maestro cannot measure rows).
- `placeholder={view.placeholder}` on the input.

**3. Screen — `apps/mobile/src/screens/SessionScreen.tsx`:** pass
`attachments={compose.chips.length}` and `editing={compose.editing !== null}`
to `<Composer>` (`SessionScreen.tsx:2413-2456`). Nothing else.

**4. Kit — `tools/mockup-kit`:** `bun run mockup-kit` regenerates
`generated/*` from the new styles; `K.composer({ compact: true })` draws the
compact row (the mockup's `composerShape` extension, moved into `kit.js` /
`kit.css` on the generated `--m-composer-*` tokens, no literals); the catalogue
`index.html` shows it. While there, fix the two drifts the mockup reported:
`.k-send-now` background `--c-tint` (the code's `palette.tint`) and caption type
(`Composer.tsx:277,282`).

**5. Changelog** — `changelog.d/mobile-composer-compact.changed.md`:

```md
- **iPhone: the empty composer rests on one row.** When the field is empty and you are not typing, the composer is a single row — `+`, the "Message tentacle" hint and the mic — and the faint send arrow that did nothing is gone. Tap the field and it opens to the usual two rows with the keyboard. It stays open while it holds something (text, a photo or file, a dictation), and ■ Stop still sits on the closed row while a turn runs.
```

### Files

In dependency order (no protocol, daemon, client or CLI change):

1. `apps/mobile/src/composer-shape.ts` — NEW, the pure rule.
2. `apps/mobile/test/composer-shape.test.ts` — NEW, its table (red first).
3. `apps/mobile/src/ui/Composer.tsx` — props, focus flag, one wrapping body,
   `composer-compact`, animation calls.
4. `apps/mobile/src/screens/SessionScreen.tsx` — two props.
5. `apps/mobile/test/composer-field-layout.test.ts` — update the structure pins
   (`:18-30` "the row is INSIDE the field", `:32-35` the 36 pt row) to the new
   shape; add the pins in Tests §source.
6. `apps/mobile/e2e/flows/23-composer-keyboard.yaml` — the new steps.
7. `tools/mockup-kit/generated/*` (regenerated), `tools/mockup-kit/kit.js`,
   `kit.css`, `kit.d.ts`, `index.html` — compact composer + the two drift fixes.
8. `changelog.d/mobile-composer-compact.changed.md` — NEW.
9. This doc (Execution).

### Failure modes

- **The reshape drops the focus** (the load-bearing one): keyboard closes on the
  first tap, typing goes nowhere. Designed out by the fixed child order; caught
  by flow 23's first `inputText` on the compact field. If it is red on device,
  STOP and report (§0) — do not switch to programmatic re-focus without updating
  this plan.
- **A remount after a send leaves `focused` stuck true** (old input never sent
  `onBlur`): designed out by keying the flag with `fieldKey`; the new input
  starts unfocused, and with the keyboard dismissed on send
  (`SessionScreen.tsx:791-795`) the field converges to compact (or open if it
  still holds chips). Pinned by the source test (`focus.key === fieldKey`).
- **Blur while holding something:** stays open (OD3) — the table's row 2.
- **Blur on an empty field with chips removed later:** a prop change re-runs the
  pure rule ⇒ compact on the next render; nothing to remember.
- **Dictation denied / cancelled from compact:** mic goes `preparing` (open) →
  `idle` with nothing typed ⇒ compact again; no stuck state (pure function of
  current props).
- **Non-editable sessions** (Loading…, ended, failed): the input cannot focus,
  `mic` is `hidden` (`SessionScreen.tsx:2450`), the slot is `up-dim` ⇒ compact
  with the hint ("This session has ended" ~170 pt fits in 360 − 40 − 20 = 300 pt).
  A leftover draft keeps it open (OD3), as today.
- **Hint too long for a compact row:** the widest compact cluster with a hint is
  mic + ■ (≈ 212 pt left for text) and the longest hint ("Not connected — tap
  Retry", non-editable, no mic) has ≈ 300 pt; the pill case drops the hint (D4).
  The voice hint (`voiceView.placeholder`) shows only while dictating ⇒ open.
- **Return / send / stop semantics:** unchanged — `composerAction` /
  `returnKeyAction` are not touched; a hidden slot is only the `none` action's
  dim face (no tap is lost: it did nothing).
- **VoiceOver:** the resting row loses a disabled "Send" button that did
  nothing; `+`, the field ("Message") and the mic keep their labels.
- **Layout animation leakage:** `LayoutAnimation.configureNext` animates the
  whole next layout batch (the list shrinking/growing with the field too) —
  that is the intended look; under Reduce Motion it is a no-op (`animate.ts:11`).
- **Floating hub jump:** the hub repositions on the band's layout
  (`floating-button.ts` `place`); when the field grows it follows the band edge.
  Check on the simulator that it does not visibly jump more than today's
  keyboard-up jump; out of scope to animate (the v2 note), log it in Review if
  it does.

### Tests

**Unit — `apps/mobile/test/composer-shape.test.ts` (red before green:** run it
before `composer-shape.ts` exists ⇒ red on the import; paste the red in
Execution). Each pins one row of the table:

1. rest: not focused, `""`, 0 chips, mic `idle`, slot `up-dim` ⇒ `compact`,
   `slotShown: false`, hint unchanged (OD1, OD2).
2. focused + empty ⇒ `open`, `slotShown: true` with `up-dim` (D2).
3. not focused + draft `"x"` ⇒ open; draft `" "` ⇒ open (D1 whitespace).
4. not focused + 1 attachment ⇒ open (OD3).
5. mic `preparing` / `listening` / `finalizing` ⇒ open; `idle` / `hidden` ⇒
   compact (D1, D5).
6. `editing: true` + empty ⇒ open (D1).
7. compact + slot `stop` ⇒ `slotShown: true` (OD2: the action returns), and the
   shape stays `compact` (D3).
8. compact + `sendNow` ⇒ hint `""`, pill case; open + `sendNow` ⇒ hint as given
   (D4).
9. totality: for every `SendSlot` × focused/holds, `shape === "open"` ⇒
   `slotShown === true` (open is today, always).
10. `composerHolds` agrees with the table (no second definition).
- **Non-vacuity by mutation** (§9): flip `focused ||` to `focused &&` ⇒ rows 3–6
  red; drop the `slot !== "up-dim"` guard ⇒ row 1 red; drop the D4 branch ⇒
  row 8 red. Record the three in Execution.

**Source pins — `apps/mobile/test/composer-field-layout.test.ts`** (Bun cannot
import RN, so like the existing file they read the source):
- `Composer.tsx` calls `composerShape(` and does not re-decide (no
  `draft === ""` / `attachments >` / `mic ===` comparisons outside the existing
  mic-face code).
- The FIRST element inside the wrapping body is `<TextInput` (no `{…}` before
  it) — the load-bearing order.
- The focus flag is keyed: the source contains `focus.key === fieldKey`.
- `onFocus=` and `onBlur=` on the input; `animateNextLayout(` used.
- `testID="composer-compact"` exists and is conditional on `view.shape`.
- `SessionScreen.tsx` passes `attachments={compose.chips.length}` and
  `editing={compose.editing !== null}`.
- Update (not delete) the old structure pins to the new structure; keep every
  testID pin.
- Show each new pin red on the current `Composer.tsx` before the edit.

**e2e — `apps/mobile/e2e/flows/23-composer-keyboard.yaml`** (the user-visible
behaviour; must be red on current `main` at its first new assert, then green):
after `turn-idle` and the `23-keyboard-closed` shot (which now shows ONE row):
1. `assertVisible composer-compact`, `assertNotVisible composer-send` (OD1, OD2).
2. `tapOn composer-input` ⇒ `assertNotVisible composer-compact`,
   `assertVisible composer-send` (open, the dim ↑ — D2).
3. `hideKeyboard` ⇒ `assertVisible composer-compact` (empty blur closes).
4. then today's B1 steps: `tapOn composer-input` (on the COMPACT field) +
   `inputText "SLOW keyboard button"` + `assertVisible composer-filled` — this
   is the load-bearing proof (keystrokes reached the reshaped input).
5. In the B2 section, after `inputText "SLOW keyboard return"`: `hideKeyboard`,
   `assertNotVisible composer-compact` (OD3: holds text ⇒ open),
   `tapOn composer-input`, then today's `pressKey: Enter`.
Run flow 23 alone on one simulator (fast gates), then the changed-flows gate;
the full e2e gate runs on `main` after merge. Attach the before/after
`23-keyboard-closed` shots to Execution.

**Visual:** the `23-keyboard-open` shot must match today's open composer
pixel-for-pixel (D2) — compare against a `main` run's shot and say so in
Execution.

**Gate before done:** `bun run check` (typecheck, lint, test) green; the kit's
drift test green after `bun run mockup-kit`.

## Execution

*— claude (Anthropic executor agent; the harness exposes no version id), 2026-11-26*

**Repro, re-run first on the branch (worktree root, no edits yet):
`.tentacle/tmp/mobile-composer-compact/rest-height.ts`** — identical to the
Context's, `root` pointed at this worktree (`…/.tentacle/worktrees/mobile-composer-compact`):

```
rest field height: 82 pt (input line 34 + row 36)
size.composer token: 48 pt
TextInput always above the row: true
send slot rendered unconditionally: true
any compact/shape branch: false
```

Same after the change (the script's `after` block, reads the regenerated tokens):

```
TextInput always above the row: false
send slot rendered unconditionally: false
any compact/shape branch: true
compact line: 36 pt → resting field: 48 pt
size.composer token: 48 pt          (48 = the resting field: CopyFlash stays right)
```

### The load-bearing check

1. **Static premise, confirmed:** today the input and the row are two SIBLINGS of
   the field (`<TextInput` then `<View style={styles.row}>`), the input is the
   field's first child, `key={fieldKey}` is on it, and both programmatic focus
   paths go through `input.current?.focus()` — so "put the input on the row" by
   re-parenting WOULD lose the first responder. Hence the single wrapping body.
2. **Proven by execution** (`.tentacle/tmp/mobile-composer-compact/reconcile.ts`,
   React reconciliation through Ink's renderer — the repo's React host; the rule
   is React's own, host-agnostic, and the control is what makes it non-vacuous):

   ```
   style-only change (compact → open): mounts 1 → 1 → 1
   control, the input re-parented: mounts 2 → 3 (a remount ⇒ keyboard lost)
   ```

   A style change on the same element at the same position does not remount; one
   level of re-parenting does. The component's structure is exactly the first
   case: `<TextInput>` is the body's FIRST child in both shapes, and everything
   that mounts/unmounts (spacer is a `display: none` style, pill, caption, mic,
   slot, both hidden observables) comes AFTER it.
3. **The device falsifier (flow 23's `inputText` on the compact field) was NOT
   run here:** this worktree has no cached e2e app build, and a cold Release
   build exceeds the executor's 15-minute foreground budget. Run it as the gate
   does: `bun run e2e:mobile --ios 26 --only 23` — the first new assert
   (`assertVisible composer-compact` at rest) is red on `main` by construction,
   and step 4 (`tapOn composer-input` then `inputText "SLOW keyboard button"` ⇒
   `composer-filled`) is the falsifier: if the reshape remounted the input, the
   keyboard drops and it is red.

### As-built, in order

1. `apps/mobile/src/composer-shape.ts` — NEW, pure, React-free.
   `composerHolds` (`:53`) and `composerShape` (`:67`), exactly the plan's table;
   types only (`MicButton`, `SendSlot`) imported with `import type`.
2. `apps/mobile/test/composer-shape.test.ts` — NEW; **red before green** (before
   the module existed):
   ```
   error: Cannot find module '../src/composer-shape.ts'
    0 pass  1 fail  1 error
   ```
   then green (12 tests, 54 expects). Rows 1–10 of the plan's table, the mic
   matrix, whitespace-`" "`, and a `composerHolds`-agrees-with-the-table sweep.
3. `apps/mobile/src/ui/Composer.tsx` — props `attachments`/`editing`; the focus
   flag `const [focus, setFocus] = useState({ key: fieldKey, on: false })` (`:235`)
   read as `focus.key === fieldKey && focus.on`; `reduceMotion` read once
   (`:231`), `shapeChange = () => animateNextLayout(reduceMotion)` (`:250`),
   called from the input's `onFocus`/`onBlur` (`:294`, `:298`) and from the mic
   tap when compact (D5); `const view = composerShape({…})` (`:237`), the
   component branching only on `view.*`; ONE `<View style={compact ?
   [styles.body, styles.row] : styles.body}>` (`:271`) with the input first; the
   slot wrapped in `{view.slotShown ? … : null}`; `placeholder={view.placeholder}`;
   `testID="composer-compact"` (`:447`) next to `composer-filled`. New styles
   `body` (wrapping row, `columnGap: 4`, `paddingHorizontal: 2`), `inputOpen`
   (`width: "100%"`, `marginHorizontal: -2`), `inputCompact` (`flex: 1`,
   `marginLeft: 38`, `paddingTop/Bottom: 7`), `plusCompact` (absolute, `left: 2`,
   `top: -4`, `marginVertical: 0`), `spacerCompact` (`display: "none"`).
4. `apps/mobile/src/screens/SessionScreen.tsx:2430-2431` — the two props.
5. `apps/mobile/test/composer-field-layout.test.ts` — the old structure pins
   updated (the body is inside the field, the input is its first element, the
   `+`'s style array) and a new block `describe("the shape: …")` with the plan's
   §source pins. **Red on the old source, all 15 of them**
   (`.tentacle/tmp/mobile-composer-compact/pins-red-on-old.ts`, run against
   `git show HEAD:`):
   ```
   red on old  imports composer-shape
   red on old  calls composerShape({
   red on old  placeholder={view.placeholder}
   red on old  {view.slotShown ? (
   red on old  focus.key === fieldKey && focus.on
   red on old  setFocus({ key: fieldKey, on: true })
   red on old  onFocus + shapeChange
   red on old  shapeChange -> animateNextLayout
   red on old  reduceMotion read
   red on old  mic tap animates from compact
   red on old  testID="composer-compact"
   red on old  body wrapper
   red on old  plus style array
   red on old  screen: attachments
   red on old  screen: editing
   ```
6. `apps/mobile/e2e/flows/23-composer-keyboard.yaml` — the plan's steps verbatim:
   `composer-compact` visible / `composer-send` not, tap ⇒ open, `hideKeyboard`
   ⇒ compact, then the tapping of the COMPACT field + `inputText`; and in B2
   `hideKeyboard` ⇒ still open (OD3) before `pressKey: Enter`.
7. Kit: `bun run mockup-kit` regenerated `generated/{tokens,kit-data}` (11 new
   `--m-composer-*` vars; `--m-composer-row-*` all still there). `kit.js`:
   `K.composer({compact})`, one `k-composer-row` body in both shapes with the
   input first, `data-abs` on the compact `+`, `display: none` on the spacer, the
   `showSlot` rule (OD2), the empty hint beside the pill (D4), a new `sendNow`
   prop + a filled `bolt.fill` symbol (the kit had the pill's CSS but no builder,
   so D4's state could not be drawn at all). `kit.css`: the body rules from the
   generated tokens (no literals), the compact line, the absolute `+`, and the
   two reported drifts fixed (`.k-send-now` → `--c-tint`, `--t-caption-*`).
   `index.html`: the conversation screen now rests compact, plus a new
   "composer at rest: closed, Stop, Send now, opened" entry.
   `scripts/test/mockup-kit.test.ts`: 5 new tests pin OD2/D3/D4 in the kit's
   markup and the body/pill CSS.
8. `changelog.d/mobile-composer-compact.changed.md` — the plan's bullet verbatim.
9. This section.

### Drift from the Implementation (and why)

- **The input's box is 4 pt narrower on the right when open.** The plan's
  geometry (body `paddingHorizontal: 2` + input `marginHorizontal: -2` +
  `width: "100%"`) makes the box 100 % of the body's *padded* content: its left
  edge and the text origin are identical to today (17 pt from the field's outer
  border) and so is every button's, but its content width is `W − 38` against
  today's `W − 34`. Measured from the tokens, not guessed. Invisible for anything
  shorter than a wrap at the last 4 pt — the `23-keyboard-open` shot's draft is
  short, so that shot is unchanged — but a draft that wraps re-wraps 4 pt
  earlier. Kept as the plan (and the mockup) specify rather than adding a
  compensating `paddingRight: 6` nobody would see; flagged for Review.
- **`styles.row` is REUSED, not dropped:** the compact body is
  `[styles.body, styles.row]` (the compact shape IS one 36 pt row), which keeps
  `--m-composer-row-height/gap/padding-horizontal` alive for `kit.css` (`.k-queue`
  and others read them) instead of leaving a dead style or renaming the metrics.
- **`kit.d.ts` untouched:** `composer` is not declared there (it falls under
  `readonly [component: string]: unknown`), so there was nothing to add.
- **The kit's `compact` defaults to `false`** (the plan does not say; the
  mockup's own extension defaulted to `true`). Every existing drawing and test
  keeps the open composer; the catalogue asks for `compact: true` explicitly.
- **The Reduce Motion hook is read into `reduceMotion`, not `reduce`,** so the
  existing "the animated faces read it twice" pin in
  `composer-field-layout.test.ts` stays untouched (it counts
  `const reduce = useReduceMotion() !== false;`), and the first-focus ref was
  renamed `autoFocused` (the plan's instruction, since `focus` became the state).
- **`scripts/test/mockup-kit.test.ts` is edited** although the Files list does
  not name it: the kit gained a shape, so it gained a test (AGENTS §9).

### Mutations (non-vacuity, §9)

`composer-shape.ts`, three mutations, reverted each time (12/12 green after):

| mutation | result |
|---|---|
| `focused \|\| composerHolds(input)` → `&&` | 4 pass, **8 fail** |
| drop the `slot !== "up-dim"` guard (`slotShown: true`) | 11 pass, **1 fail** |
| drop the D4 branch (`placeholder: input.placeholder`) | 11 pass, **1 fail** |

The load-bearing experiment carries its own mutation (the re-parent control:
1 → 1 mounts versus 2 → 3).

### Verification run here

`bunx biome check` clean on all eight changed TS/JS files; `tsc --noEmit -p
apps/mobile` clean; `bun test` on the touched/covering files only (in the
foreground): `composer-shape`, `composer-field-layout`, `composer`,
`composer-compose`, `motion-literals`, `theme`, `session-screen`,
`session-screen-compose`, `session-screen-follow-wiring`, `voice-wiring`,
`notice-row`, `bundle-node-free`, `scripts/test/mockup-kit*` — **all green**.
The full `bun run check` and the e2e gate are the orchestrator's, after this.


## Review

*— <model-id>, <YYYY-MM-DD>*
