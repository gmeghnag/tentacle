# fix/mobile-chat-glitches — rename dialog clipped, "Sending…" stuck, open-chat scroll stops short

> **Status:** implementation (APPROVED — see below)
> **Branch:** `fix/mobile-chat-glitches`
> **Type:** fix · **Size:** M · **Blast:** cross-module · **Suited:** a strong model executes (the bug-2 slice touches `@tentacle/client` and the outbox's F3 durability contract); Review **fresh-context** (sub-agent or `/code-review`), red-teaming F3 ("an item leaves disk only once the daemon has its key")
> **Changelog:** `changelog.d/mobile-chat-glitches.fixed.md`

**Implementation APPROVED by the orchestrator (owner request 2026-11-15).** No
owner decision is open: all three are defects against behaviour the app already
promises (an alert-style dialog, a pending row that clears once sent, follow =
"at the end").

## Context

*— claude-opus-5-5, 2026-11-15*

The owner hit three glitches live on an iPhone 12 Pro (iOS 18.3.1), app built
from `main` `b44766f8`, session over the relay to `serve` (Qwen3.8 27B).
Screenshots: `.tentacle/tmp/mobile-chat-glitches/rename-clipped.png`,
`sending-stuck.png` (gitignored; described below). This branch is cut from
`b9b2d4fb`, which already contains the `feat/mobile-voice` merge
(Composer/SessionScreen/Settings), so nothing has to be rebased over it. The
design still keeps away from the voice code: no edit to `Composer.tsx`,
`voice-*.ts` or Settings, and in `SessionScreen.tsx` it touches only the follow
callbacks (lines 225–264) and the FlatList's `onLayout`/`contentContainerStyle`
props.

### Bug 1 — the Rename dialog looks clipped at the top

*Trigger:* tap the session title → "Rename session" opens with `autoFocus`, so the
keyboard comes up. *Collateral:* none: the transcript stays put.

**Evidence (screenshot measured; 1170×2532 px, shown at 924×2000, 3 px/pt):**
- The card spans y = 826…1175 (shown). Its centre is **1000.5 = exactly half the
  2000-px window**. So the card is centred in the WHOLE window: the keyboard is
  ignored. The keyboard's top is at 1205, so the card's bottom clears it by only
  30 px shown ≈ **13 pt**, and only by chance.
- The title's 25-pt line box (`typography.title3`, `theme.ts:175`, 59 px shown)
  runs 826…885, centred at 855.5. That is where the "Rename session" glyphs are
  centred. So the title **starts flush at the card's top edge**, with no top
  inset at all. That is the "half hidden" look: the cap height touches the
  rounded edge, and the bubble behind it shows right above.

**Source (cause):** `apps/mobile/src/screens/RenameSheet.tsx:131`
`card: { …, overflow: "hidden", gap: 12 }`: no `paddingTop`, and the title
`<Text>` (`:43`) is the card's first child. `:32` `<Modal transparent>` + `:129`
`root: { flex: 1, justifyContent: "center" }`: the card is centred in the Modal's
own window. A RN `Modal` is a separate native window, so the screen's
`KeyboardAvoidingView` (`SessionScreen.tsx:329`) does not reach it, and nothing
inside the Modal avoids the keyboard. With the error line (`:61`, footnote + 12-pt
gap ≈ 30 pt, so the bottom moves down ≈ 15 pt) or a larger Dynamic Type, the
card's bottom (Save) goes under the keyboard.

**Repro attempt on the simulator: FAILED for an unrelated reason.** I appended
probe steps to flow 24 and ran `bun run e2e:mobile --ios 26 --only 24-ui-shots`
(2026-11-15). The steps: a shot of the rename dialog with the keyboard up, a
shot at open plus one after a swipe, and a `HOLD` send. The tree was restored
afterwards, and the steps are kept in `.tentacle/tmp/mobile-chat-glitches/probe-steps.yaml`.
The Release build failed before any flow ran:
```
build/install failed for iOS 26 (exit 1)
❌  cannot find 'PushCore' in scope
   └─ apps/mobile/targets/notification-service/PushCore/PushPipeline.swift:55:20
```
(run dir `.tentacle/tmp/e2e-mobile/1794756122283/build-ios26.log:410`). This is
an environment/build issue of the notification-service target, not of this task.
Per AGENTS §0 it was not retried. **The executor re-runs the probe once the
build is green** (see Tests, "device evidence").

### Bug 2 — a second "Scrivi qualcosa" bubble stuck on "Sending…"

*Trigger:* Send with the link up. *Magnitude:* the row stays for **the whole
turn** (a 27B model "thinking" makes that long), then vanishes at the turn's end.
*Collateral:* the transcript already shows the sent bubble and "Thinking".

**Not a double send.** The daemon runs one turn per key:
`HostedSession.prompt` answers a known `turnId` from its ledger and "never runs a
second turn" (`packages/daemon/src/hosted-session.ts:2254-2257`). The screenshot
shows ONE user row in the transcript and ONE turn. The dashed row is the outbox
item drawn by the view (`session-view.ts:396-403`, `outbox-look.ts:27`).

**Repro (pure, no simulator):** `.tentacle/tmp/mobile-chat-glitches/repro2-sending.test.ts`.
It copies the harness of `apps/mobile/test/session-screen-compose.test.ts:19-198`
verbatim, imports rewritten to `../../../apps/mobile/src/`. ONE change: the fake
`send` keeps its turn open after the first deltas, like a model still thinking:
```ts
let release: () => void = () => {};
const gate = new Promise<void>((r) => { release = r; });
// in the fake session's async *send(prompt):
            yield { type: "user_message", text: prompt } as never;
            yield { type: "text", delta: "thinking…" } as never;
            // The turn keeps running (a 27B model thinking): the stream stays open.
            await gate;
            yield { type: "turn_end", reason: "end_turn" } as never;

test("REPRO bug 2: the sent prompt's outbox row while its turn runs", async () => {
  const h = harness();
  const screen = h.screen();
  await screen.open();
  screen.setDraft("Scrivi qualcosa");
  screen.press();
  await settle();
  const v = screen.state().view;
  console.log("sent to daemon:", JSON.stringify(h.session.sent));
  console.log("store items (turn running):",
    JSON.stringify(h.store.data.items.map((i) => ({ text: i.text, state: i.state }))));
  console.log("view.outbox (turn running):", JSON.stringify(v.outbox));
  console.log("view mentions of the text:", JSON.stringify(v).split("Scrivi qualcosa").length - 1);
  release();
  await settle();
  console.log("view.outbox (turn ended):", JSON.stringify(screen.state().view.outbox));
});
```
`bun test ./.tentacle/tmp/mobile-chat-glitches/repro2-sending.test.ts` (2026-11-15, bun 1.4.3):
```
sent to daemon: ["Scrivi qualcosa"]
store items (turn running): [{"text":"Scrivi qualcosa","state":"sending"}]
view.outbox (turn running): [{"itemId":"k","text":"Scrivi qualcosa","state":"sending","decide":false}]
view mentions of the text: 2
view.outbox (turn ended): []
 1 pass
```
That is one send, but two copies on screen while the turn runs, and the outbox
row clears only at the turn's end. This is exactly the screenshot.

**Root cause (one sentence):** the online send settles its outbox item when the
**turn ends**, not when the **daemon accepts** the prompt. The chain:
`compose-controller.ts:404` `await deps.prompt(...)`, then `:423`
`driver.settle(itemId)`. `deps.prompt` is the screen's `promptWithRefs`
(`session-screen-controller.ts:415`, `:728-769`), which awaits
`feed.ownTurn(...)`, i.e. the whole stream, before it returns (`:756`).
The same port backs the driver's replay `run` (`session-screen-controller.ts:386`,
`App.tsx:290`), so a reconnect send also stays `sending`, and holds that
session's driver queue (`outbox-driver.ts:250`, inside `exclusive`) for the
whole turn.

### Bug 3 — opening a chat lands a little above the end

*Trigger:* open a session with more than a screen of history. *Magnitude
(predicted from the source, not yet measured on a device):* a **constant 16 pt**
short, the list's `paddingBottom`. A constant tied to the layout structure means
a layout bug (AGENTS §1). *Collateral:* no "Jump to latest" pill: 16 pt is within
`NEAR_BOTTOM_PT = 48` (`follow.ts:11`), so follow stays on. That matches the
owner's account: no pill, they just scroll the last bit by hand.

**Source (cause):** `SessionScreen.tsx:254-260` follows with
`list.current?.scrollToEnd({ animated: true })`. FlatList's `scrollToEnd` is
`VirtualizedList.scrollToEnd`
(`node_modules/.bun/@react-native+virtualized-lists@0.88.0+…/Lists/VirtualizedList.js:135-152`):
```js
const frame = this._listMetrics.getCellMetricsApprox(veryLast, this.props);
const offset = Math.max(0, frame.offset + frame.length + this._footerLength - this._scrollMetrics.visibleLength);
this.scrollToOffset({animated, offset});
```
The target is "the last CELL's end − viewport". The content container's padding
after the last cell is not in it: `styles.list = { paddingTop: 8, paddingBottom: 16 }`
(`SessionScreen.tsx:695`, applied at `:453`). Every follow therefore stops
exactly 16 pt above the real end. That includes the last one at open, after the
final cell is measured. Before that, `getCellMetricsApprox` (an average
estimate for a cell not yet measured) can leave it further off, until the next
content-size change.

A second, lesser path in the same place: follow reacts only to
`onContentSizeChange`. If the list's **viewport** shrinks after the last content
change, the end slides out of view and nothing re-follows. Things that appear
after the attach can cause this: the header's context bar
(`SessionScreen.tsx:385-400`), the compose notices and the queue rows.

**Evidence status:** proven from the RN source, which is the code that runs. The
device measurement (open, then swipe: the difference should be 16 pt = 48 px on
a 3× screen) is the probe above, blocked by the same build failure.
**Unverified part:** that 16 pt is the WHOLE observed gap on the owner's device.
To check it, run `probe-steps.yaml`'s `probe-3-open` vs `probe-3-after-swipe`
shots.

## Implementation

*— claude-opus-5-5, 2026-11-15*

### Load-bearing assumption

**Bug 2:** the daemon's answer to `session/prompt` (the ack) means it holds the
turn under the item's key. A later retry with the same key is answered from
the ledger and never runs twice (`hosted-session.ts:2254-2257`). And
`RemoteSession` sees that ack: `sendPrompt`'s `request.then((ack) => { turn.acked = true; … })`
(`packages/client/src/remote-session.ts:1321-1335`). So finishing the item
**at the ack** keeps F3 ("on disk until the daemon has the key",
`outbox-driver.ts:136-147`, `:503-506`). Today the ack is NOT exposed to callers:
`send`'s `opts` is `{ skill, turnId, attachments }` (`:1055-1059`). And an own
turn emits no event at its `turn_start` (`onUpdate`, `:1757-1772`, pushes a
`user_message` only for a send-now/reset). So the first event can come
**seconds** after the ack: "first event" is not the ack.

### Preconditions

- `turn_start` is emitted BEFORE the ack is returned (`hosted-session.ts:2283-2313`,
  `emit` then `return { turnId }`), and on one ordered connection. Not relied on
  for correctness, only noted.
- `driver.settle(itemId)` with no error = "accepted": the item is finished and its
  `busy` reservation freed (`outbox-driver.ts:495-507`). A second `settle` of a
  gone item returns `"sent"` harmlessly (`:497-499`).
- `refusalOf` maps `SessionNotOpenError("link")` to `offline`: the item stays
  `waiting`, key kept (`outbox-session.ts:24-44`). A relaunch/reconnect `run`
  `decide`s it, and a key the daemon already holds comes back `"sent"`
  (`outbox-driver.ts:327-330`).
- The feed draws the own prompt "at the stream's FIRST event, i.e. once the
  daemon took it" (`session-feed.ts:82-88`, `:126-144`). That is the same
  proxy as the bug, so it moves to the ack too (below).
- `scrollToOffset` / `onContentSizeChange(w, h)` / `onLayout` are FlatList
  (ScrollView) props. `h` is the native content height, which **includes** the
  container padding.
- AGENTS §7 "logic in pure modules": the follow target and the ack outcome go in
  `follow.ts` / `session-feed.ts`. The components only perform what they say.

### Design

**Bug 2 — settle at the daemon's ack (one signal, two consumers).**
1. `@tentacle/client` `RemoteSession.send(prompt, signal, opts)` gets an
   additive `opts.onAccepted?: () => void`. It is threaded into the
   `ActiveTurn` and called **once** in `sendPrompt`'s ack branch (`:1325`),
   also for an `ack.ended` retry. It is never called on refusal. There is no
   wire or protocol change: the ack already exists. (`sendNow` is out of scope:
   it has no outbox item.)
2. `session-feed.ts` `ownTurn(turnId, events, prompt, accepted?: Promise<void>)`.
   When `accepted` resolves, the pending own prompt is drawn (`drawPrompt(null)`).
   The existing first-event draw stays as a fallback for a stream whose first
   event is the reset replay (not doubled: `pending` is drawn once). So the
   sent bubble appears at the ack, the same moment the outbox row goes.
3. `session-screen-controller.ts` `promptWithRefs`: new contract, **resolves at
   acceptance** while the turn keeps folding in the background (`ownControl`
   reset + `emit()` move to the fold's own completion). It rejects with:
   - the stream's error, if it failed before acceptance (unchanged meaning: a
     refusal gives the words back, F7);
   - `new SessionNotOpenError("link")`, if the stream ENDED with neither an
     acceptance nor an error (a cut link). Today that silently counts as sent.
     Now it is `offline`: the key is kept and the reconnect decides.

   An error AFTER acceptance is the transcript's (LOST, folded by the feed), as
   today for "streamed".
4. `compose-controller.ts`: **no logic change.** `sendNowHere` already settles
   when `deps.prompt` resolves (`:423`) and refuses when it rejects
   (`:405-421`). Only the `deps.prompt` doc comment changes to "resolves at the
   daemon's ack". The driver's `run` path benefits for free: `perform` awaits
   the same port (`outbox-driver.ts:250`), so it no longer holds `exclusive`
   for a turn.
5. `outbox-session.ts` `outboxSessionOf(...).prompt` (the drained port, used
   when no screen folds): same contract. It resolves at `onAccepted`, keeps
   draining detached, and rejects as in 3. `OutboxSession.prompt`'s doc
   (`outbox-driver.ts:59-60`) states it.

**Bug 3 — follow to the TRUE end, from native metrics, in `follow.ts`.**
- `follow.ts` owns the target: `endOffset(m: { content; viewport }) = max(0, content − viewport)`.
  `contentGrew(state, m)` returns `{ state, scrollTo: number | null }` instead of
  the `scrollToEnd` boolean. A new `viewportChanged(state, m)` does the same for
  a layout change: following → `scrollTo` the new end; not following → nothing,
  and no `unseen` (no content arrived).
- `SessionScreen.tsx` keeps `content` from `onContentSizeChange(_w, h)` and
  `viewport` from the FlatList's `onLayout`. It performs
  `list.current?.scrollToOffset({ offset, animated: true })` for `onContentSize`,
  `onJump` and the new `onLayout`. `scrollToEnd(` disappears from the screen.
  `paddingBottom` stays: it is now inside the native `content`, so the end
  includes it.
- Why not a 16-pt footer instead (`_footerLength` IS in RN's formula)? It would
  fix this padding, but it would leave the target in RN's estimate-based math
  (`getCellMetricsApprox`) and outside a tested module. The native content
  height is the exact property (AGENTS §2).

**Bug 1 — the dialog sits in the free area, with an alert's insets
(presentation only, the component's job per §7).**
- `RenameSheet.tsx`: wrap the Modal's `root` in a `KeyboardAvoidingView
  behavior="padding"` (iOS; `undefined` elsewhere, as `SessionScreen.tsx:332`
  does). The Modal is its own window, so it needs its own. The card is then
  centred in the space above the keyboard.
- `card` gets `paddingTop: 20` (the iOS alert's title inset). The title gets
  `maxFontSizeMultiplier` like the header's dense text (`DENSE_FONT_SCALE`), so
  Dynamic Type cannot push Save under the keyboard.
- No view-model change: `session-rename.ts` (logic) is untouched.

### Files

In dependency order:
1. `packages/client/src/remote-session.ts`: `opts.onAccepted` on `send` → `runTurn` → `ActiveTurn` → `sendPrompt` ack branch.
2. `apps/mobile/src/session-feed.ts`: `ownTurn(..., accepted?)`, drawn at acceptance.
3. `apps/mobile/src/session-screen-controller.ts`: `promptWithRefs` resolves at acceptance; `SendableHandle.send` opts gain `onAccepted` (`:66-71`).
4. `apps/mobile/src/outbox-session.ts` + the doc of `OutboxSession.prompt` in `outbox-driver.ts:59-60`.
5. `apps/mobile/src/compose-controller.ts`: doc comment of `deps.prompt` only (`:145`, `:390-399`).
6. `apps/mobile/src/follow.ts`: `endOffset`, `contentGrew(state, m)` → `scrollTo`, `viewportChanged`.
7. `apps/mobile/src/screens/SessionScreen.tsx`: follow callbacks (`:225-264`) + FlatList `onLayout`/`onContentSizeChange` props (`:431-470`).
8. `apps/mobile/src/screens/RenameSheet.tsx`: KAV inside the Modal, `paddingTop`, font cap.
9. `changelog.d/mobile-chat-glitches.fixed.md`: one bullet.

There is no protocol change (no `protocol.d/` note) and no persisted-format change.

### Failure modes

| Case | Converges to |
|---|---|
| Refusal before the ack (`TurnInProgress`, busy, dead link) | unchanged: `promptWithRefs` rejects with it, so `settle(item, error)` runs and the words come back or the sheet decides (F7). No bubble is drawn (no acceptance). |
| Stream ends with no ack and no error (link cut mid-request) | **new:** reject `SessionNotOpenError("link")`, so the item is `offline`/`waiting` with its key. The reconnect `run` asks the daemon, which answers `"sent"` if it had it (`outbox-driver.ts:327`) or sends it once. Never a silent drop, never a double send. |
| Ack arrives, then the stream throws | the item is already finished (the daemon has it). The feed folds LOST, as it does for any streamed turn today. |
| App killed between the ack and `settle`'s disk write | the item stays `sending` on disk, and the relaunch `decide`s it → `"sent"` (the key is known). This is F3's existing case. |
| `ack.ended` (a retried key whose turn already finished) | `onAccepted` fires, the item is finished, and the client's `finish` ends the turn as today. |
| Reset replay after acceptance | the prompt is already drawn (`pending` null). `history_reset` replaces the rows and the replayed `user_message` folds once. Pinned by a test. |
| Ack before any event (the normal own turn) | the bubble is drawn at the ack: no gap between the row leaving and the bubble appearing. |
| A short window between acceptance and the row leaving (async `finish` write) | the bubble and the dashed row overlap for at most one disk write. Accepted, the same as today's end-of-turn overlap but milliseconds long. |
| Follow while the person dragged up | `contentGrew` returns `scrollTo: null` + `unseen` (unchanged). `viewportChanged` returns null and no `unseen`. |
| Content shorter than the viewport | `endOffset` = 0 (clamped), so no negative offset. |
| Viewport/content unknown yet (0 before the first layout) | no scroll until both are known (`scrollTo: null`). |
| Rename with the error line, or a large Dynamic Type | the KAV keeps the card above the keyboard, and the title cap bounds its growth. |

### Tests

Red first for each, run on the current code before the fix (AGENTS §9):

- **`packages/client/test/prompt-accepted.test.ts` (new):** reuse the in-memory daemon/fake-connection pattern of `remote.test.ts`.
  (a) `onAccepted` is not called before the prompt response, and is called
  exactly once after it, before any turn event. (b) It is never called when the
  prompt is refused. (c) It is called for an `ended` retry ack.
  Red: the option does not exist (the TS error / never-called spy).
- **`apps/mobile/test/session-feed.test.ts`:** (a) `ownTurn` with an
  `accepted` that resolves while the stream has yielded nothing: the user row
  is in the state. (b) No acceptance, then a refusal: no user row. (c) A reset
  replay after acceptance: exactly one user row. Red: (a) fails today (the
  prompt is drawn only at the first event).
- **`apps/mobile/test/session-screen-compose.test.ts`:** the repro above, made
  an assertion. The fake `send(prompt, signal, opts)` calls `opts.onAccepted?.()`
  and then holds its turn open on a gate. While it runs: `view.outbox` is `[]`,
  the store has no item, and the transcript has exactly ONE row with the text.
  Red on today's code: `view.outbox` has the `sending` row (repro output
  above). Also: a fake whose stream ENDS with no `onAccepted` and no error →
  the item is `waiting` (not finished). The existing "a REFUSED send gives the
  words back" (`:271`) and "SENDS the field's text" (`:255`) stay green.
  Non-vacuity: mutate `promptWithRefs` back to awaiting the fold → the first
  test goes red.
- **`apps/mobile/test/follow.test.ts`:** `contentGrew(initialFollow, { content: 1016, viewport: 600, offset: 0 }).scrollTo === 416`
  (the end INCLUDING the padding). `viewportChanged` while following → the new
  end; while not following → null and `unseen` unchanged; short content → 0.
  Red: `contentGrew` returns no offset today.
- **`apps/mobile/test/session-screen-follow-wiring.test.ts` (new, a source pin in
  the style of `field-reveal.test.ts:55-70`):** `SessionScreen.tsx` has no
  `scrollToEnd(`, calls `scrollToOffset(` with follow's target, and wires the
  FlatList's `onLayout` to `viewportChanged`. `RenameSheet.tsx`: a
  `KeyboardAvoidingView` inside the `Modal`, and the card style has a non-zero
  `paddingTop`. Red: all match today's source as missing.
- **Device evidence (Execution, once the iOS build is green):** re-run
  `probe-steps.yaml` (append it to flow 24, `--only 24-ui-shots`, then restore)
  on the buggy code and on the fix. Record: (1) the rename card's top ≥ 20 pt
  above the title and its bottom above the keyboard; (3) `probe-3-open` ==
  `probe-3-after-swipe` (no movement left); (2) during `HOLD`, no dashed row.
  Then the owner's device check on the iPhone 12 Pro. The build failure
  (`PushCore`) is not this task's to fix. If it persists, record that and
  escalate rather than work around it.
- Gate: `bun run check` (typecheck incl. `tsc -p apps/mobile`, lint 0/0, full
  `bun test`).

## Execution

*— <model-id>, <YYYY-MM-DD>*

## Review

*— <model-id>, <YYYY-MM-DD>*
