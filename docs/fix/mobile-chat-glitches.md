# fix/mobile-chat-glitches — mobile chat glitches (items 1, 2, 3, 5, 6, 9, 10)

> **Status:** implementation APPROVED by the owner (2026-11-15)
> **Branch:** `fix/mobile-chat-glitches`
> **Type:** fix · **Size:** L (revision 2; was M) · **Blast:** cross-module · **Suited:** a strong model executes. The bug-2 slice touches `@tentacle/client` and the outbox's F3 durability contract. Review is **mandatory fresh-context** (sub-agent or `/code-review`), red-teaming F3 ("an item leaves disk only once the daemon has its key").
> **Changelog:** `changelog.d/mobile-chat-glitches.fixed.md`

Scope: items 1, 2, 3 (first triage) and 5, 6, 9, 10 (owner, 16:27–16:42),
from `.tentacle/tmp/mobile-chat-glitches/ITEM4.md`. Items 4, 7, 8 and 11 are
**feat/mobile-chrome**, not here.

**Revision 2 (claude-opus-5-5, 2026-11-15):**
- Added items 5, 6, 9 and 10.
- Re-checked item 2 against the new evidence: the root cause holds, with daemon-log proof.
- Re-sized M → L.
- Revoked the earlier approval: Owner questions are open (user-visible labels),
  and item 9 needs one on-device diagnostic before its fix can be designed.

## Context

*— claude-opus-5-5, 2026-11-15 (revision 2 the same day: items 5, 6, 9, 10 and the item-2 re-check)*

The owner hit these glitches live on an iPhone 12 Pro (iOS 18.3.1), app built
from `main` `b44766f8`, session over the relay to `serve` (Qwen3.8 27B).
Screenshots (gitignored; described below), all in `.tentacle/tmp/mobile-chat-glitches/`
except the last:
- `rename-clipped.png`
- `sending-stuck.png`
- `composer-tall-after-send.png`
- `subagent-stuck.png`
- `../mobile-chrome/session-info-current.png`

This branch is cut from `b9b2d4fb`, which already contains the
`feat/mobile-voice` merge (Composer/SessionScreen/Settings), so nothing has to
be rebased over it. To keep conflicts with later voice work small:
- `voice-*.ts` and Settings are not touched.
- `Composer.tsx` changes by ONE prop (the field's `key`, item 6).
- `SessionScreen.tsx` changes only in the follow callbacks (lines 225–264), the
  FlatList's `onLayout`/`onContentSizeChange` props and one keyboard effect
  (item 5).

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
a build bug of the notification-service target, not of this task.
`PushPipeline.swift:55` qualifies `PushCore.render(...)` with the SwiftPM
package's module name. That compiles under `swift test`, where the module IS
`PushCore`, but not inside the Xcode extension target, whose module has
another name (introduced by `9aa171c2`). **Escalation for the orchestrator:**
this breaks `bun run e2e:mobile` itself (Decision 20's merge gate) on current
`main`. It needs its own fix task.
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

**Item 2 re-check (revision 2): the owner's new evidence fits this root cause.**
Two new screenshots: `subagent-stuck.png` (16:42, sent while IDLE) and
`composer-tall-after-send.png` (16:27, which the owner thought was a message
sent while a turn ran). I read the `serve` daemon's own logs, read-only:
`~/.config/tentacle/daemon/proj-2a4dc70b7988/<uid>.jsonl`.
- "Un subagent che faccia un'azione lunga" (session `949a98d0…`) is in the
  daemon log **once**, as the user message of turn `502b6aea`:
  ```
  52 {"type":"turn_start","turnId":"502b6aea-…","seq":70,…}
  53 {"type":"message",…,"message":{"role":"user","content":"Un subagent che faccia un’azione lunga"},"seq":71,…}
  ```
  The sidecar (`949a98d0….state.json`) shows that turn **still open**:
  `turns[-1] = {"turnId":"502b6aea-…"}` with no `end`, and `turn.pending` holds
  one `shell` ask (see item 10). Settle-at-turn-end + a turn that never ends =
  a "Sending…" row **forever**. An idle send changes nothing: the phone's OWN
  send starts the turn, and the header's "Running" is that turn.
- "Vada per la sentinella…" (session `ba4826fb…`, the 16:27 screenshot) is a
  **prompt**, not a steer:
  ```
  181 {"type":"turn_start","turnId":"7862e252-…","seq":318,…}
  182 {"type":"message",…,"content":"Vada per la sentinella, non overdittare …","seq":319,…}
  ```
  A prompt is accepted only with no turn running (`TurnInProgress` otherwise),
  so it too was sent while idle. Its own turn is the "Running" in that header.
- The two paths can be told apart in the code. A steer settles at the
  `enqueue` ack (`compose-controller.ts:620-623`). Its row is the **"Queued ·
  the agent reads these at its next step"** card (`ComposeBar.tsx:86-113`),
  never a long-lived dashed "Sending…" bubble. So both screenshots show bug 2
  and nothing else. Whether a different label is wanted is Owner question Q1.

### Item 5 — the keyboard stays up after Send

*Trigger:* Send (button or Return) with the keyboard up. *Observed*
(`composer-tall-after-send.png`): the keyboard stays, and the reply has
≈ 40 % of the screen.
**Repro (source, deterministic):** no code path ever dismisses the keyboard
after a send. `rg "Keyboard.dismiss|\.blur\(\)" apps/mobile/src` returns
nothing. The only dismissal is the list's drag
(`keyboardDismissMode="interactive"`, `SessionScreen.tsx:454`).
`Composer.tsx:104-109` keeps the field focused on purpose (`submitBehavior="submit"`).
**Root cause:** a missing behaviour, not a regression. The owner now asks
for it.

### Item 6 — after Send, the empty field stays as tall as the sent text

*Trigger:* send a multi-line message. *Magnitude (measured from
`composer-tall-after-send.png`, 3 px/pt):*
- The capsule spans y = 928…1183 shown, which is ≈ **108 pt**. One line is
  `size.composer` (48 pt).
- The field's padding is 13 + 12 pt (`Composer.tsx:197`). 108 − 25 ≈ 83 pt,
  which is ≈ **3–4 lines of 17-pt body text**: the height of the text just sent
  (3 lines in its outbox bubble).
- The placeholder sits at the top and the photo button at the bottom
  (`capsule` `alignItems: "flex-end"`, `:184`).

The height is tied to the PREVIOUS content (AGENTS §1). The field was cleared
(`setDraft("")`, `compose-controller.ts:657`) but its multiline height was not
measured again.

**Root cause (mechanism UNVERIFIED):** the RN iOS (new architecture)
multiline `TextInput`, cleared programmatically from inside its own submit
event (`submitBehavior="submit"` → `onSubmitEditing` → `press` →
`setDraft("")`), keeps the content height of the text it had. Nothing in our
code sets a height: the style has only `maxHeight: 132`. So the stale height is
the native view's own. A simulator run could confirm this (see "Device
evidence"); the screenshot is the only evidence today. The fix below does not
depend on the exact native mechanism.

### Item 9 — Session info: "Context · Couldn't load"

*Trigger:* open Session info (session `949a98d0…` over the relay, serve 0.6.0,
Qwen local). *Observed:* `Couldn't load` with an orange dot
(`session-info.ts:330-332`, the `kind: "error"` branch).

**What is known (source):**
- The daemon's `session/context` is documented to never throw
  (`hosted-session.ts:2179-2185` → `Agent.contextUsage`, `agent.ts:1675-1700`:
  `countTokensBounded`, capped by `COUNT_TOKENS_CAP_MS = 2000`
  (`core/src/context.ts:11`), else the estimate).
- The connection looks the session up among the ones THIS connection opened
  (`connection.ts:549`, `lookup`).
- The app calls the screen's own handle (`App.tsx:378-385`) →
  `RemoteSession.context()` (`remote-session.ts:914-928`) →
  `client.sessionContext` (`remote-client.ts:1023-1034`).
- Any rejection that is neither "not connected" nor `MethodNotFound` becomes
  `kind: "error"`, and **the error itself is discarded**
  (`session-info-controller.ts:113-140`, `settle`/`pull`). Nothing is logged.

**Not reproduced.** The e2e flow 25 (mock model, local route) asserts the same
row as loaded. The differences with the owner's setup are the relay, the
local Qwen count endpoint and a 25-tool MCP server. I could not probe the live
daemon safely: attaching a test client to `949a98d0…` would join a session
with a pending `shell` ask, and a client with an allow-all broker could approve
it. Copying the log out of the config dir needs the owner's approval. Per §0
(two static attempts, no progress) the root cause is **open**. The plan below
makes it diagnosable first and fixes it second.

### Item 10 — after a "background" sub-agent launch, the phone looks stuck on "Running"

*Trigger:* the model called `agent_task` (16:41:47). *Observed:* a spinner
card "Agent · Task lungo in background", "Running", nothing moves.

**Evidence (daemon, read-only):**
- The call has **no `background: true`**, so it is a FOREGROUND child
  (`agent_task` offers `background` only as an explicit argument,
  `tools/src/task.ts:93-107`). The model's text said "in background", but
  the call did not ask for it:
  ```
  54 {"type":"message",…"toolCalls":[{"id":"KX70Q6wq…","name":"agent_task","arguments":"{\"description\":\"Task lungo in background\",…,\"subagent_type\":\"general\"}"}]}
  55 {"type":"call_started","callId":"KX70Q6wq…",…,"ts":1794757307781}
  ```
- The parent turn therefore **really waits** for the child's report (the
  turn-based contract, `task.ts:107`). The child's task is six `sleep 10`
  shells, each a local-27B model step. The sidecar, written at 16:53:35, still
  shows the turn open with a child `shell` ask pending, attributed to the parent
  call (`subagent.ts:150`, `:178`):
  `"pending":[{"toolCallId":"KX70Q6wq…","tool":"shell","requestedAt":1794758028174}]`
  (16:53:48). Auto-accept is client-side (`remote-session.ts:368-376`): an
  ask waits until an attached client answers it. If the phone is backgrounded
  or detached, it waits.
- **The phone shows none of the child's work.** The client maps the daemon's
  `tool_progress` into `subagent_start/tool/usage/end` events
  (`client/src/mapping.ts:134-170`). The TUI folds them into the card
  (activities, tool count, tokens: `tui/src/state.ts:495-545`). The phone's fold
  **drops them**: `transcript.ts:414-419`, `default: return state`.

**Repro (pure):** `.tentacle/tmp/mobile-chat-glitches/repro10-subagent.test.ts`.
It folds `turn_started` + an `agent_task` `tool_start`, then five sub-agent
progress events:
```ts
s = apply(s, { type: "tool_start", id: "call-1", name: "agent_task", arguments: "{}" } as never);
for (const event of [
  { type: "subagent_start", id: "call-1", agentType: "general", description: "Task lungo in background" },
  { type: "subagent_tool", id: "call-1", label: "shell: sleep 10" },
  { type: "subagent_usage", id: "call-1", usage: { promptTokens: 900, completionTokens: 40 } },
  { type: "subagent_tool", id: "call-1", label: "agent_notify" },
  { type: "subagent_tool", id: "call-1", label: "shell: sleep 10" },
]) s = apply(s, event as never);
console.log("state changed by 5 sub-agent progress events:", JSON.stringify(s) !== before);
```
`bun test ./.tentacle/tmp/mobile-chat-glitches/repro10-subagent.test.ts` (2026-11-15):
```
rows: 1
state changed by 5 sub-agent progress events: false
 1 pass
```
The Agent tool row exists, and five progress events change NOTHING. (The
`subagent_usage` shape in this repro is approximate. It does not matter: every
`subagent_*` kind falls into the same `default`.)

**Root cause:** the turn genuinely blocks on a foreground child, and its asks
need an attached client. That is daemon behaviour as designed, not a phone
fault. The phone **drops every sub-agent progress event**, so a minutes-long,
legitimate wait looks identical to a hang. The model calling it "background"
without `background: true` is model behaviour. It is out of scope here, noted
for the tool-description owners.

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

*— claude-opus-5-5, 2026-11-15 (revision 2 the same day)*

Items 1–3 are planned in full below. Items 5, 6, 9 and 10 follow in
"Revision 2 — items 5, 6, 9, 10", then the Owner questions.

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

### Revision 2 — items 5, 6, 9, 10

#### Load-bearing assumptions (one per item)

- **5 + 6:** a send that CLEARED the field is one observable moment that a
  pure module can count. `press` reads and clears the field in one synchronous
  step (`compose-controller.ts:597-600`, `:655-657`, F4). The 12c path does the
  same in `send` (`session-screen-controller.ts`).
- **9:** none yet. The root cause is open (Context). Step 9a makes the failure
  observable. The fix (9b) is designed only from 9a's evidence.
- **10:** the client already delivers sub-agent progress as `SessionEvent`s on
  the turn's stream, keyed by the PARENT call id (`client/src/mapping.ts:134-170`).
  The fold only has to keep them, as the TUI's does (`tui/src/state.ts:495-545`).

#### Design

**Items 5 + 6 — one counter, two presentations.**
- The screen state gets `sends: number`, incremented by the controller exactly
  when a press cleared a non-empty field. That covers send, queue/steer and
  send-later. It does not cover Stop, a blank Return or a refused-before-clear
  press. The decision lives in the controller, and the tested rule is "the field
  was cleared by a send".
- `SessionScreen.tsx` (presentation only):
  - **item 5:** a `useEffect` on `state.sends` calls `Keyboard.dismiss()`,
    skipping the first render.
  - **item 6:** `<Composer fieldKey={state.sends} …>`, and `Composer.tsx` sets
    `key={fieldKey}` on its `TextInput`. A fresh native view measures its
    (empty) content from scratch.
- This does not depend on the unverified native mechanism. A remount needs no
  focus to survive, because item 5 dismisses the keyboard at the same moment
  (the two are deliberately one change).
- Dictation: `voice-controller` writes through `setDraft`, not a `TextInput`
  ref (`Composer.tsx` has none), so a remount loses nothing. The executor
  checks this against `voice-wiring.test.ts` before relying on it.

**Item 9 — diagnose, then fix.**
- **9a:**
  - `session-info-controller.ts` `settle` keeps a SAFE description of the
    error: its class (`RpcError` code + `data.reason` if any, `TimeoutError`, or
    `Error`) and NO message text, because the app log is exportable and must
    carry no content (F16, flow 21).
  - The port reports it through the existing app log (`app-log.ts`) as
    `session-info context failed: <class>`.
  - The view is unchanged: a label change is Owner Q4.
- **Owner step:** reproduce on the phone, then Settings → Export logs. That
  line names the failing layer: a relay timeout, `UnknownSession` from
  `lookup`, a parse error, or something else.
- **9b:** the fix for that class, added to this doc as revision 3 with its
  own red-first test, before Execution of item 9. If 9a's class is
  `UnknownSession`/`NotAttached`, the likely culprit is `RemoteSession.context()`
  answering with an id the connection does not hold. Named as a hypothesis only.

**Item 10 — show the child working.**
- `transcript.ts`: `ToolRow` gets an optional `sub: { activities: readonly
  string[] (last 3); toolUses; tokens; done; stopReason?; movedTo? }`.
- `subagent_start / _tool / _usage / _end` update it through the existing
  `updateTool` (`:487-495`), with the same rules as the TUI's fold and the
  same cap. A progress event for an unknown call id is a no-op, as
  `updateTool` already is.
- Labels arrive already sanitized by the client (`progressText`,
  `mapping.ts:154`). The fold still caps their length.
- `ToolRow.tsx` (presentation): under the Agent card's title, one line with the
  latest activity and the counts (wording: Owner Q2). The spinner stops at
  `done`.
- The pending ask is NOT a phone bug: the existing permission sheet shows asks
  attributed to the parent call. The executor verifies this with a test
  (below) and does not assume it.

#### Files (revision 2, appended to the list above)

10. `apps/mobile/src/session-screen-controller.ts`: `sends` counter (5/6).
11. `apps/mobile/src/screens/SessionScreen.tsx`: the `Keyboard.dismiss()`
    effect + `fieldKey` prop (5/6).
12. `apps/mobile/src/ui/Composer.tsx`: `fieldKey` → `TextInput key` (6).
13. `apps/mobile/src/session-info-controller.ts` + `App.tsx` `infoWiring`:
    the error class + app-log line (9a).
14. `apps/mobile/src/transcript.ts`: `ToolRow.sub` + the four `subagent_*` cases (10).
15. `apps/mobile/src/ui/ToolRow.tsx`: the progress line (10).

Still no protocol, wire or persisted-format change.

#### Failure modes (revision 2)

| Case | Converges to |
|---|---|
| Send refused AFTER the field cleared (owner B4: words come back) | `sends` already incremented. The keyboard is down and the field is remounted with the restored text, at its own height. Acceptable: the notice says why. Pinned by a test. |
| Return on a blank field / Stop | no increment: keyboard and field untouched. |
| Two presses in one frame (F4) | one clear, one increment (the second press finds the field empty). |
| Dictation listening while Send is tapped | the voice controller stops on send (its own rule). The remount happens after. Verified by the `voice-wiring` test, which must stay green. |
| Item 9a: the error's message carries content (a path, a prompt) | only the class/code is logged, never the message. A test feeds an error whose message holds a canary, and the canary must not reach the log. |
| Item 10: progress for a call id the fold never saw (reattach mid-child) | no-op (`updateTool`). The resync's history carries the finished report. |
| Item 10: a child that MOVED to the background (`subagent_end{stopReason:"background", agentId}`) | `done` + `movedTo`, so the card stops spinning and says where it went (wording Q2). |
| Item 10: a flood of `subagent_tool` (a long child) | the activities are capped (last 3, like the TUI's `SUB_ACTIVITY_CAP`). The count keeps growing, so the state stays bounded. |

#### Tests (revision 2, red first)

- **5/6, `apps/mobile/test/session-screen-compose.test.ts`:**
  - Send with text → `state().sends` goes 0 → 1.
  - Queue (a turn running, `session.turn("t")`) → +1.
  - Blank Return → unchanged.
  - Stop → unchanged.
  - Two presses in one frame → +1.
  - Refused send (`refuseSend`) → +1, with the words back in `draft`.

  Red: `sends` does not exist. Mutation: increment in `setDraft` instead
  (i.e. on typing too) → the "blank Return/Stop" cases go red.
- **5/6 source pin** (in the new `session-screen-follow-wiring.test.ts`):
  `SessionScreen.tsx` calls `Keyboard.dismiss()` in an effect keyed on
  `state.sends`, and `Composer.tsx` sets `key={fieldKey}` on the
  `testID="composer-input"` `TextInput`. Red today.
- **9a, `apps/mobile/test/session-info-controller.test.ts`:**
  - a `context()` rejecting with `new RpcError(-32050, "secret /Users/x/…")`
    → the logged line carries `RpcError -32050` and NOT the canary text;
  - a `TimeoutError` → `TimeoutError`;
  - the view is unchanged (`Couldn't load`).

  Red: nothing is logged today.
- **10, `apps/mobile/test/transcript.test.ts`:**
  - the repro above made an assertion: after the five events, the `agent_task`
    row has `sub.toolUses === 2`, `sub.activities` ending in `"shell: sleep 10"`,
    and `sub.tokens === 940`;
  - `subagent_end` → `done: true`;
  - `stopReason: "background"` + `agentId` → `movedTo`;
  - an unknown id → state identical;
  - 10 activities → the last 3 kept.

  Red: the repro output above (`false`). Parity: one case reuses a TUI
  `state.ts` fixture sequence and compares counts.
- **10, ask visibility, `apps/mobile/test/permission-sheet.test.ts`:** an ask
  whose `toolCallId` is an `agent_task` call id (a child's) is shown, and with
  shared auto-accept on, auto-accepted. If this goes RED, that is a second
  item-10 bug: the executor STOPS and reports it in Execution (the plan does
  not cover its fix).
- **Device evidence (5/6/10)**, once the `PushCore` build bug is fixed:
  - type a 3-line text, Send, then `maestro hierarchy` → `composer-input`
    bounds are back to one line, and no keyboard;
  - a foreground `agent_task` on the mock model → the card's progress line
    changes.

#### Owner questions (the doc stays NOT approved until answered)

- **Q1 — the outbox row's "Sending…" label.** After the fix, the dashed
  "Sending…" row is visible only between the tap and the daemon's ack
  (milliseconds online), or while an offline item is being sent on reconnect.
  "Queued" already names something else: the steer card "Queued · the agent
  reads these at its next step" (`ComposeBar.tsx:93-94`).
  **Recommendation: keep "Sending…"** (accurate after the fix). Calling a
  prompt "Queued" would confuse it with steers.
- **Q2 — the Agent card's progress line (item 10).**
  **Recommendation: TUI parity**:
  - running: `<last activity> · <N> tool uses` (e.g. `shell: sleep 10 · 3 tool uses`);
  - done: `Done · <N> tool uses`;
  - moved: `Moved to background · sa-N`;
  - tokens hidden on the phone (dense).
- **Q3 — keyboard dismiss scope (item 5).** "After sending" read as every send
  from the field: Send, Return, a queued steer, Send later. Not Stop.
  **Recommendation: yes, all four.** The alternative is a prompt only, keeping
  the keyboard for a quick follow-up steer.
- **Q4 — item 9's error wording.** Keep `Couldn't load` until 9b, or show the
  class (e.g. `Couldn't load · timed out`)?
  **Recommendation: keep it now.** Decide with 9b once the cause is known.

#### Owner answers (2026-11-15)

- Q1: **keep "Sending…"**.
- Q2: **TUI parity** for the Agent card line (running `<last activity> · <N> tool uses`, done `Done · <N> tool uses`, moved `Moved to background · sa-N`, no tokens).
- Q3: **every send dismisses the keyboard except Stop** (Send, Return, queued steer, Send later).
- Q4: not asked — the recommendation stands by default (no visible change): keep `Couldn't load` until 9b decides with data.
- Blocker: `fix/push-extension-build` merge approved by the owner (iOS build on main).

**Implementation APPROVED by the owner (2026-11-15).**

## Execution

*— claude-opus-5-5, 2026-11-15*

**Load-bearing check (re-run first): HOLDS.** `hosted-session.ts:2254-2257`
answers a known `turnId` from the ledger. `remote-session.ts` `sendPrompt`'s ack
branch sets `turn.acked` and is the only place the ack is visible. `send`'s opts
had no hook for it, and an own turn pushes no event at `turn_start`
(`onUpdate`; it pushes only for `sendNow`/`reset`).

**Slices, in plan order. Each test was red on its assertion before the fix,
unless noted.**

1. **Bug 2, client.** `packages/client/src/remote-session.ts`:
   - `send`/`runTurn` take `opts.onAccepted`.
   - `ActiveTurn.onAccepted` is called once in the ack branch, before `finish`
     for an `ended` ack, then cleared, so a re-send's ack does not call it again.

   New `packages/client/test/prompt-accepted.test.ts` (raw `RpcPeer` daemon):
   - "once, after the answer, before any event": red;
   - "`ended` retry ack": red;
   - "never on a refusal": green on both. It guards the fix and is not a red test.
2. **Bug 2, feed.** `session-feed.ts` `ownTurn(…, accepted?)` draws the prompt
   at acceptance. A `closed` flag stops a late ack from drawing after the end.
   Tests in `session-feed.test.ts`:
   - "accepted with no event yet → row": red;
   - "reset replay after acceptance → once": red;
   - "refusal → no row" and "late ack draws nothing": guards.
3. **Bug 2, the two ports.** New pure helper `untilAccepted` in
   `outbox-session.ts`. Both `promptWithRefs` (`session-screen-controller.ts`)
   and `outboxSessionOf(...).prompt` use it:
   - it resolves at `onAccepted` or at the first event;
   - it rejects with the stream's error if neither came first;
   - it rejects with `SessionNotOpenError("link")` on an unanswered end.

   `ownControl` is cleared only when the fold ends, and only if it is still this
   turn's. Doc comments changed in `compose-controller.ts` and `outbox-driver.ts`;
   no logic change there. Tests:
   - `session-screen-compose.test.ts` "no outbox row / no stored item / ONE copy
     while the accepted turn runs": red (the repro's `sending` row);
   - "stream ENDS unanswered → item `waiting`": red;
   - new real-daemon test in `outbox-link.test.ts`: the port resolves while the
     `hold` turn is held, and the daemon has one user message;
   - existing "SENDS the field's text" and "REFUSED send gives the words back":
     still green.
4. **Bug 3.** `follow.ts`:
   - `endOffset`, `endTarget` (null while a size is 0);
   - `contentGrew(state, size)` returns `scrollTo`;
   - new `viewportChanged`.

   `SessionScreen.tsx`:
   - keeps a `size` ref, updated by `onContentSizeChange(_w, h)`, the FlatList's
     new `onLayout` and `onScroll`;
   - performs `scrollToOffset`; `scrollToEnd(` is gone.

   Tests:
   - `follow.test.ts`: the existing cases moved to the new signature, plus the
     plan's cases (416, clamp 0, unknown size, viewport changes);
   - assertion-red shown on the old module from scratch:
     ```
     old contentGrew → {"state":{"following":true,"unseen":false},"scrollToEnd":true}
     Expected: 416
     Received: undefined
     ```
   - source pins in the new `session-screen-follow-wiring.test.ts`. Their
     regexes were run against `git show HEAD:` copies of the files: 3/3 fail.
5. **Bug 1.** `RenameSheet.tsx`:
   - a `KeyboardAvoidingView` (`padding` on iOS) inside the `Modal`;
   - `card.paddingTop: 20`;
   - the title gets `maxFontSizeMultiplier={DENSE_FONT_SCALE}`.

   Its pins were red before the edit.
6. **Items 5/6.** `session-screen-controller.ts`:
   - `SessionScreenState.sends`;
   - `press()` now wraps the old body (`act()`) and counts when the field was
     non-blank before and `""` after. Every send path clears it in the same
     synchronous step (F4). Dictation goes through `press`/`pressReturn` too
     (`SessionScreen.tsx` voice `send`).

   `SessionScreen.tsx`:
   - an effect on `[state.sends]` calls `Keyboard.dismiss()` when `> 0`;
   - `<Composer fieldKey={state.sends}>`.

   `Composer.tsx`:
   - `fieldKey` prop and `key={fieldKey}` on `composer-input`;
   - no `TextInput` ref exists there, so a remount loses nothing.

   Tests in `session-screen-compose.test.ts`:
   - 8 cases: Send, Return, queued steer, Send later, blank Return, Stop,
     double tap, refused send;
   - all 8 were red (`undefined`);
   - the source pins were red.

   `voice-wiring.test.ts` stays green.
7. **Item 9a.** `session-info-controller.ts`:
   - `pull` reports a plain failure (`kind: "error"`; not offline or
     MethodNotFound) through the new `InfoPort.onPullError(section, errorShape(error))`;
   - `errorShape` comes from `app-log.ts`: the class plus the numeric code,
     never the message.

   `App.tsx` `infoWiring` logs it:
   ```
   warn client-error source=session-info section=<s> error=<class> code=<n>
   ```
   The view is unchanged (Q4). Tests: the RpcError canary (`-32050`, the message
   absent), `TimeoutError`, and offline/MethodNotFound not reported. Red: nothing
   was reported.
8. **Item 10.**
   - `transcript-rows.ts`: `ToolRow.sub: SubProgress`.
   - `transcript.ts`: the four `subagent_*` cases, using the TUI's rules through
     `updateTool`, with `SUB_ACTIVITY_CAP = 3` and `SUB_LABEL_MAX = 120`.
   - `tool-summary.ts`: `subAgentLine` with the Q2 wording. `toolMeta` stops the
     spinner when `sub.done`.
   - `TranscriptRow.tsx`: one footnote line `tool-<id>-progress` under the row.

   Tests:
   - `transcript.test.ts`: the repro as an assertion, end, moved, unknown id
     (same object), flood (last 3), label cap. 4 of them red: the repro, end,
     moved, flood. The label-cap test had passed vacuously, so it now also
     asserts one activity.
   - `transcript-parity.test.ts`: TUI parity, with the same counts as
     `applySessionEvent`.
   - `tool-summary.test.ts`: assertion-red, via a stub `subAgentLine` that
     returned `null`.
   - Ask visibility: `permission-sheet-auto-accept.test.ts`. A child `shell` ask
     in the parent's turn is shown with its agent label when auto-accept is off,
     and gets `allow_once` when it is on. **It was green on the first run**, as
     the plan expects: no second item-10 bug.
9. `changelog.d/mobile-chat-glitches.fixed.md`: one bullet. No `protocol.d/`
   note: the wire, the schema and `protocol.json` are untouched.

**Mutations (each run, then reverted):**

| Mutation | Result |
|---|---|
| `promptWithRefs` returns `run.accepted.then(() => run.done)` (await the fold again) | compose "ONE copy while the turn runs" RED |
| `untilAccepted` resolves on an unanswered end | compose "item WAITING" RED |
| port returns `.done` instead of `.accepted` | outbox-link "resolves at the ACK" RED (`"hung"`) |
| `sends` counted in `setDraft` (typing) instead of `press` | "blank Return → unchanged" RED |
| `sends` counted on every press | "Stop → unchanged" + "two presses → +1" RED |
| 9a reports `error.message` | canary + timeout cases RED |
| `subagent_tool` → `return state` | repro, flood, label cap, parity RED |

**Drift from the Implementation (and why):**
- **`SUB_ACTIVITY_CAP`.** The plan says "last 3, like the TUI's
  `SUB_ACTIVITY_CAP`", but the TUI's cap is **50** (`tui/src/state.ts:275`). The
  phone keeps the plan's 3, because it draws only the latest activity. Its own
  constant documents this.
- **The plan's item-10 repro.** It expected `toolUses === 2` after **three**
  `subagent_tool` events, so the correct value is 3. It also used `tool_call`
  and a nested `usage`. The real shapes are `tool_start` and flat
  `promptTokens`/`completionTokens` (`client/src/mapping.ts:158-165`). The tests
  use the real shapes.
- **Acceptance fallback.** "Accepted" is the ack OR the stream's first event,
  in the caller as well as the feed. The plan kept the first-event fallback for
  the feed only. Without it, a `turn_end` consumed a few microtask hops before
  the ack's `.then` would read as "unanswered". That would be harmless (the
  reconnect asks the daemon, which says `sent`), but it would be spurious. It
  also keeps today's rule for a failure after events: never give the words back.
- **One shared helper.** `untilAccepted` (`outbox-session.ts`) serves both
  ports, so the contract lives in one place and is not written twice.
- **9a.**
  - `data.reason` is **not** logged: it is daemon text, and the app log admits
    none (F16, `app-log.ts` header). The numeric code already tells the layers
    apart.
  - All four sections report a plain failure, not only Context, because they
    share the same `pull`.
  - The log uses the existing kind `client-error`, since `AppLogKind` is a
    closed set with no free text.
- **Item 10 placement.**
  - The progress line is rendered in `TranscriptRow.tsx` `ToolRowView` (it
    already owns the lines under a row: reply, diff, output), not in
    `ToolRow.tsx`.
  - The ask-visibility test is in `permission-sheet-auto-accept.test.ts`, which
    has the auto-accept harness. The sheet keys on `turnId` and never sees a
    `toolCallId`.
- **`sends`.** It is counted once, in `press()` (before/after the field), not at
  each clear site. The rule is the same, from one place.
- **Plan's 5/6 mutation note.** "blank Return/Stop go red" is not what happens.
  The `setDraft` mutation reddens blank Return only (the Stop test types
  nothing). Stop and the double tap redden under the "count every press"
  mutation, so both are covered.
- **Extra test:** the `outbox-link.test.ts` real-daemon test, which pins F3 end
  to end through the real `RemoteSession` ack.

**Unverified:**
- **Device evidence: not run.** The plan's probe needs
  `.tentacle/tmp/mobile-chat-glitches/probe-steps.yaml`, which is **not in the
  scratch dir** (it was not kept). The flow 24 run also needs the simulator.
  Still to check: the 16-pt landing (bug 3), the rename inset/keyboard (bug 1),
  the composer height and keyboard (5/6) and the Agent card line (10). Check
  them on the simulator or the owner's iPhone.
- `App.tsx`'s `onPullError` → `APP_LOG` line is covered by typecheck only. The
  controller half is tested.
- 9b (the actual fix for "Couldn't load") waits for the owner's exported log
  line, as planned.

**Gate (2026-11-15, bun 1.4.3):**
- `bun run typecheck` (root + `apps/mobile` + `apps/relay`): clean.
- `bun run lint`: 0 errors, 0 warnings (1608 files).
- `bun test`: **11530 pass, 5 skip, 0 fail** (11535 tests, 828 files). The 5
  skips are all opt-in tests: k8s live ×2, docker live ×2, slow socket.

## Review

**Verdict: APPROVE** (no HIGH/MEDIUM findings). Scope: `git diff main...HEAD` only.

**Gate (re-run by the reviewer):** the 11 touched test files: 172 pass, 0 fail.
`bun run lint`: clean (1608 files). `bun run typecheck`: clean (root, mobile,
relay). Full `bun test` not re-run here; Execution reports 11530 pass / 5 opt-in skips.

**Mutation non-vacuity (each reverted; `git status` clean, byte-identical afterwards):**
- `remote-session.ts` ack branch: `onAccepted` not called. 3 red: `prompt-accepted` (a)+(c), and `outbox-link` "port's prompt done at the ACK".
- `session-screen-controller.ts` `sends += 0`: 6 red (`sends` cases, refused send included).
- `follow.ts` `endOffset` 16 pt short (the bug's own magnitude): 4 red (`follow`, "true end", "viewport shrinks").
- `session-feed.ts` draw-at-ack inverted (`closed`): 4 red (the ack-draw, reset-replay, late-ack and compose ACK tests).
- `transcript.ts` `subagent_end` `done: false`: 3 red, including the TUI-parity fixture.
- Weak spot, not a finding: dropping `subagent_start` turns no test red, because `subagent_tool`/`end` fall back to `?? EMPTY_SUB`. The only observable lost is the "0 tool uses" line before the first child tool.

**Attacks tried:**
1. *Driver queue released at the ack* (`outbox-driver.ts` `perform` → `session.prompt` now resolves early). The next queued prompt's `runOne` reads facts with turn 1 running. `decide` (`outbox.ts:191-203`) then returns `decide/changed` (the sheet), never a blind send or a `TurnInProgress` loop. Before this change it reached the same sheet at turn end (history length changed). Holds.
2. *Stop before the ack.* `onAbort` sets `abortWanted`. The ack still calls `onAccepted` and then re-sends the cancel (`remote-session.ts` ack branch). The item settles `sent` and the turn ends cancelled. No resurrection, no false `link` rejection. Holds.
3. *Stream ends with no ack and no events.* `untilAccepted` rejects `SessionNotOpenError("link")`, so the item becomes `waiting` with its key and `decide` answers `sent` on reconnect if the daemon took it. A key-preserving retry, never a silent drop. Holds.
4. *Reset replay after an early draw.* The client's `reset` path (`remote-session.ts:1574`, `:1785`) queues `history_reset` before the replayed `user_message`, so the rows are replaced first and the prompt shows once. Pinned. Holds.
5. *`ack.ended` retry:* `onAccepted` runs before `finish`, so the bubble is drawn before `closed`. Pinned by test (c) plus the feed's late-ack test. Holds.
6. *§7 invariants:* client change is additive (an optional callback, no wire field, no `protocol.d/` needed). No persistence, broker or peer-serialisation path touched. Logic stays in pure modules (`follow.ts`, `untilAccepted`, `subAgentLine`, `sends` counting in the controller), and the `.tsx` changes only render or perform. Holds.

**Notes (below MEDIUM):** `toolMeta` shows tone `ok` for a sub-agent that is done even when its `stopReason` is an error/cancel. This lasts only until the call's own result lands. Cosmetic.

**Executor behaviour:** the diff matches the Implementation's file list and order. Tests name their mutation, and the ones I re-ran went red as claimed. No scope creep found.

**Reviewer independence:** a fresh context on a different model family from the executor (DeepSeek), so blind spots are less likely to be shared.

*— claude-opus-5-5, 2026-11-15*
