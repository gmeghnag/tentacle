# feat/mobile-queued-compose — Pending message in the transcript & in-field composer

> **Status:** implementation (plan written, NOT approved — see Owner questions)
> **Branch:** `feat/mobile-queued-compose`
> **Size:** M (mobile only, if Owner Q1 = split) — L if the daemon "unqueue" stays in this branch · **Blast:** cross-module (mobile) — load-bearing for the unqueue slice (agent steering queue, protocol) · **Suited:** Opus plan; DeepSeek exec for the mobile slices; Opus exec + fresh-context Review for the unqueue slice
> **Changelog:** `changelog.d/mobile-queued-compose.changed.md` — "**Queued messages show in the conversation.** A message sent while the agent works appears as a pending bubble you can edit, send now or cancel; the composer holds its buttons inside the field."

## Context

*— claude-opus-5-5, 2026-11-17*

**Problem (owner, 2026-11-17, phone).** A message typed while a turn runs goes
into a separate "Queued" card above the input (`ComposeBar.tsx:60-156`), with a
44 pt full-width **Send now** pill (`ComposeBar.tsx:138-153`, `styles.sendNow`
`:327-334`). The owner wants the queued message where it will land — in the
transcript, as a pending user bubble — and the composer's controls inside the
field, with Send now as a small control beside ↑.

**Decisions already taken (owner, mockups picked 17/11 ~21:40,
`.tentacle/mockups/mobile-queued-compose/README.md` "CHOSEN"):**
- **Q1** pending bubble = P2+P3 mix: DIMMED fill + clock glyph + "Pending · next
  step". Transition: Send now tapped → footnote "⇥ Sending now · stopping the
  step" → the bubble turns solid (the delivered row), footnote gone.
- **E1** tap the pending bubble → inline "Edit · Send now · Cancel". Edit: text
  back in the field with "Editing pending message ×"; ↑ re-queues, × restores.
- **Q2** B: "⇥ Send now" + ↑ in the field's bottom row — but Send now appears
  ONLY while a message I sent is pending (not merely while typing during a turn).
- **Q3** one field (text on top, 36 pt bottom row): "+" on the left (→ the attach
  sheet), mic + send slot on the right; the send slot is ↑ or ■ (same place/size).

**What exists today (evidence, cited — the feat's "repro" is that the capability
is missing):**
- Send now is offered on a typed text alone while a turn runs:
  `composer.ts:128-136` (`sendNowOffered` → `true` for `text !== ""`), pinned by
  `apps/mobile/test/composer-compose.test.ts:135`
  (`sendNowOffered(input({ turn: OWN, text: "typed" }))).toBe(true)`). The owner's
  Q2 rule makes that `false`.
- No pending row in the transcript: the FlatList draws `state.view.rows` only
  (`SessionScreen.tsx:535`, `:992`); queued rows live in `QueueRows`
  (`SessionScreen.tsx:1236-1242`).
- No way to edit/cancel a queued row: the protocol has no method that removes a
  WAITING row. `session/reclaim` drops ids from `returned` only
  (`protocol/src/session.ts:1486-1501`; daemon `hosted-session.ts:1859-1868`
  filters `this.returned`, never `this.queue`). Method list:
  `protocol/src/methods.ts` (`Reclaim` at `:137`; no withdraw/unqueue).
- The composer is a capsule + an OUTSIDE round action (`ui/Composer.tsx:101-199`):
  photo glyph (`:113-123`), field, mic (`:142-164`), then the 48 pt action
  (`:173-198`) — not the chosen one-field layout.

**Dependency.** TODO orders this "after fix/mobile-queued-stuck" — a queued row
that never leaves the phone's list (the stuck bug) would become a pending bubble
that never leaves the transcript, which is worse. That branch exists but has no
commits yet (`git log main..fix/mobile-queued-stuck` empty, 2026-11-17).

## Implementation

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**A pending bubble is a pure projection of the queue state the phone already
holds, and it leaves exactly when the row leaves that state.** The rows come
from `shownRows` (`compose-queue.ts:81-104`) over the daemon's FULL `queued`
state (`protocol/src/session.ts:590-631`: "A row leaves `entries` in the
`queued` that follows its `steer` … the send-now `turn_start` whose prompt
carries it … or its turn's `turn_end`"), read by the controller's
`queueRows(state)` (`compose-controller.ts:613`, `compose-state.ts:195-197`).
The delivered text reaches the transcript on its own: a steer is folded into a
user row (`transcript.ts:481-484`), a send-now's prompt arrives as its turn's
user message. So moving the rows from the card into the transcript changes
WHERE they render, not WHEN they appear or leave — provided the stuck bug is
fixed (Dependency). The executor's first step re-checks this with the store +
fake connection test the stuck fix adds (enqueue during a turn → `queued`
without the id → zero pending bubbles).

**For the Edit/Cancel slice only:** the daemon's two queues are positionally
parallel — `HostedSession.queue` (ids) and `Session.steering` (texts): every
push is paired (`hosted-session.ts:3690-3691`, resume `:1103-1109`) and the
drain names each `steer` by `this.queue.shift()` in order (`:3085-3091`) while
the agent splices all texts at once (`agent/src/session.ts:314-323`). Removing
index *i* from both in one synchronous stretch keeps them parallel, and since
the drain is synchronous too there is no in-between: an id is either still in
`this.queue` (withdrawable) or already drained (too late). The executor proves
"parallel" with a test before writing the method (enqueue 3, withdraw the
middle, drain → the two steer events carry ids 1 and 3 with texts 1 and 3).

### Preconditions

- Logic in pure modules, components render (AGENTS §7): projection, the send
  slot, Send now's rule and the edit state go in `compose-queue.ts`,
  `composer.ts`, `compose-state.ts`; `.tsx` maps values.
- "Mine" is the PERSISTED `own` map and given-back text is always MY text, never
  the daemon's (`compose-queue.ts:12-24`): a pod daemon is not trusted (§7). Edit
  puts `own.get(id)` in the field, never a daemon-supplied text.
- Send now's semantics stay today's: `controller.sendNow()` takes my `queued`
  rows + the field (`compose-controller.ts:817-872`) over `session/send_now`;
  `takeForSendNow` marks rows `sending` (`compose-queue.ts:138-144`), `handOff`
  drops them when the new turn starts (`:151`).
- The attach sheet already exists with Photo library · Camera (· PDF when
  offered) (`attach-sheet.ts:38`, `session-view.ts:154-158`, opened by
  `SessionScreen.tsx:751` `openAttach`): "+" just opens it. `Icon` has `"plus"`
  (`ui/Icon.tsx:17`).
- The FlatList already has a footer (the Thinking node,
  `SessionScreen.tsx:1072-1081`) and follows content-size changes
  (`onContentSizeChange={onContentSize}`, `:1116`): a footer that grows keeps
  the end in view while following, without touching `rows` keys or the
  step/layout cells (`layout.cells`, `:996`).
- Protocol: a new METHOD is free (AGENTS §7 forward-compat: an unknown method →
  `MethodNotFound`, handle it); no `protocol.d/` note, no version bump.
- `session/enqueue` keeps an accepted id in `this.enqueued` forever
  (`hosted-session.ts:3667-3670`): a late retry of a withdrawn id must stay a
  no-op success — withdraw must NOT delete it from `enqueued`.

### Design

**D1 — Pending bubbles (pure projection).** New `pendingBubbles(rows: readonly
ShownRow[]): readonly PendingBubble[]` in `compose-queue.ts`:
`{ id, text, mine, phase: "pending" | "sending" }` from `ShownRow.state`
(`queued` → `pending`, `sending` → `sending`), in delivery order. Mine and
other devices' both appear (today's card shows both, `ComposeBar.tsx:96-113`);
another device's carries "· another device" and is NOT tappable (no E1: I can
neither edit nor cancel another writer's words). Rendered as the FlatList
footer AFTER the Thinking node (it is read at the next step, so it is the
thread's last node): right-aligned user-bubble shape, dimmed fill, clock glyph
+ footnote "Pending · next step"; `sending` → footnote "⇥ Sending now ·
stopping the step". It disappears in the `queued` that drops it; the solid
user row is the transcript's own (steer fold / the send-now turn's prompt). No
new state, no timer.

**D2 — E1 actions (pure).** `bubbleActions(bubble, ctx) →
readonly ("edit" | "send-now" | "cancel")[]`: empty unless `mine` and phase
`pending` and the link is up and a turn runs; "send-now" also requires
`sendNowOffered`; "edit"/"cancel" also require the daemon to support unqueue
(D5; a `MethodNotFound` once → the session marks it unsupported and they are
hidden). The open bubble id is screen state (one open at a time; tap elsewhere
closes) — presentation, not logic.

**D3 — Send now's new rule.** `sendNowOffered` (`composer.ts:128-136`) becomes:
turn running ∧ link up ∧ not ended ∧ `ownPending > 0`, where `ownPending` =
my rows with state `queued` (NOT `sending`: once tapped it "leaves the composer,
it is in flight", mockup cell 2). The typed-text trigger and its photo clause
go. `ComposerInput.ownQueue` is renamed `ownPending` and both producers
(`session-view.ts:413-420`, `compose-controller.ts:629-637`) count
`mine && state === "queued"`. The action itself is unchanged (still carries the
field's text if any — Owner Q4).

**D4 — The one-field composer.** `composer.ts` gains `sendSlot(action):
"up" | "up-dim" | "stop" | "clock"` — a total map of the existing
`composerAction` (`send`/`queue` → `up`, `none` → `up-dim`, `stop` → `stop`,
`send-later` → `clock`); no new branching on state, so the truth table stays
the single source (`composer.ts:75-103`). `ui/Composer.tsx` is re-laid out per
Q3: one field (fill, 1 pt separator stroke, 22 pt radius), the `TextInput` on
top, a 36 pt bottom row: `+` (→ `onPhoto`, the attach sheet), spacer, `⇥ Send
now` pill when `sendNow`, mic, the send slot. testIDs kept: `composer-input`,
`composer-photo` (now the `+`), `composer-send`/`composer-stop`/
`composer-send-later`, `composer-mic*`, `composer-filled`; `composer-send-now`
moves into the field. `QueueRows` loses its Send now pill and its queued rows;
what remains is another device's RETURNED rows with Take (Owner Q3).

**D5 — Unqueue (daemon + protocol + client), for Edit/Cancel.**
- Protocol: `session/unqueue` `{ sessionId, ids: string[1..] }` →
  `{ removed: string[] }` (ids that were still waiting and are now gone). An id
  not waiting (delivered, carried by a reserved send-now, unknown) is not in
  `removed` — never an error, so a retry is safe. Not gated by who asks (one
  token, one principal, same as `reclaim` `session.ts:1490-1491`); the phone
  only asks for its own ids.
- Agent: `Session.unqueueAt(index)` removes `steering[index]` and
  `voiceMarks[index]` together (`agent/src/session.ts:97`, `:297-300`).
- Daemon: `HostedSession.unqueue(ids)` — synchronous, like `enqueue`/`reclaim`:
  for each id at index *i* in `this.queue`, splice it and call
  `session.unqueueAt(i)`; for an id in a reserved successor's `steers`
  (`hosted-session.ts:3673-3680`), splice it there; an id in the successor's
  `messages` (already cited by an in-flight send-now) is NOT removed. Keep
  `enqueued`. Then `persist()` + `publishQueue()` (as `:1865-1867`). Wired in
  `connection.ts` beside `reclaim` (`:424`, `:671-677`); an archived session →
  `removed: []`.
- Client: `RemoteClient.unqueue(sessionId, ids)`; mobile `compose-handle.ts`
  port beside `reclaim` (`:86-87`).

**D6 — Edit / Cancel flow (pure state in `compose-state.ts`).**
- **Cancel:** `unqueue([id])`. `removed` has it → drop the local row and the
  `own` entry; nothing goes to the field. Not removed → notice "already read by
  the agent" (it is or will be in the transcript). Error → notice, row kept.
- **Edit:** `unqueue([id])`. Removed → `editing = { text: own.get(id), prior:
  field }`, the field becomes `restoreAfterFailure(field, text)`
  (`composer.ts:157-165`, never overwrites typed text), banner "Editing pending
  message ×". ↑ while a turn runs is the ordinary `queue` action (a NEW id; ends
  `editing`). × → re-enqueue `editing.text` with a new id and set the field back
  to `editing.prior`. Not removed → notice "already read by the agent — it can't
  be edited", field untouched.
- While editing, the message is NOT queued (Owner Q2): the agent cannot read a
  half-edited text.

### Files

Dependency order. Slice A = D5 (load-bearing); slices B–C = mobile.

A. `packages/protocol/src/session.ts` (`UnqueueParams/Result` schemas),
   `packages/protocol/src/methods.ts` (`Unqueue`); `packages/agent/src/session.ts`
   (`unqueueAt`); `packages/daemon/src/hosted-session.ts` (`unqueue`),
   `packages/daemon/src/connection.ts` (dispatch); `packages/client/src/remote-client.ts`
   (`unqueue`). Tests beside each.
B. `apps/mobile/src/composer.ts` (D3 rule, `sendSlot`),
   `apps/mobile/src/session-view.ts` + `compose-controller.ts` (`ownPending`),
   `apps/mobile/src/ui/Composer.tsx` (Q3 layout), `screens/compose/ComposeBar.tsx`
   (`QueueRows` → returned-others only), `screens/SessionScreen.tsx` (Send now
   prop into `Composer`).
C. `apps/mobile/src/compose-queue.ts` (`pendingBubbles`, `bubbleActions`),
   `compose-state.ts` (editing), `compose-controller.ts` (`edit`, `cancel`),
   `compose-handle.ts` (`unqueue` port), new `screens/compose/PendingBubble.tsx`,
   `screens/SessionScreen.tsx` (footer).
Flows: `apps/mobile/e2e/flows/12-steer.*`, `13-send-now.*` (`composer-queue` /
`queued-row-*` → `pending-<id>-<mine|other>`), `apps/mobile/test/e2e-flows.test.ts`.
`changelog.d/mobile-queued-compose.changed.md`.

### Failure modes

- **Row never leaves `queued`** (stuck bug) → a bubble stays forever. Converges
  only once fix/mobile-queued-stuck lands; hence execution waits for it.
- **Edit/Cancel races the drain** → `removed` lacks the id; the text is (or
  will be) a transcript row; the phone shows "already read by the agent" and
  puts nothing in the field — never both sent AND in the field.
- **Unqueue lost on a dropped link** → nothing changed daemon-side or it did:
  the next full `queued` state decides; the row is shown iff listed. Edit puts
  text in the field ONLY after a `removed` answer, so a lost answer leaves the
  bubble and no field copy.
- **Late enqueue retry of a withdrawn id** → no-op (`enqueued` kept).
- **Unqueue during a reserved send-now** → an id in `successor.messages` is
  not removed (the send-now owns it); one in `successor.steers` is.
- **Turn ends while editing** → ↑ is `send` (a new prompt) per the existing
  truth table; × has no turn to queue into → it only clears `editing` and
  leaves the text in the field (never a silent drop).
- **Older daemon** → `MethodNotFound` on unqueue: notice once, Edit/Cancel
  hidden for that session; the row stays queued.
- **Pod daemon lies in `removed`** (names an id it did not remove) → worst case
  my own text is in the field and later delivered too; the text is mine, never
  the daemon's (D6 reads `own`). Accepted, same trust class as today's hand-back.
- **Another device's pending row** → shown, never actionable here.
- **Send now tapped twice** → the second sees `ownPending = 0` (rows `sending`)
  and is not offered.

### Tests

- `composer-compose.test.ts`: flip `:135` to `false` (red on today's code);
  `ownPending` counts `queued` only; `sendSlot` total over every
  `composerAction` kind.
- `compose-queue.test.ts`: `pendingBubbles` order/phase/mine; `bubbleActions`
  matrix (other device, `sending`, link down, no turn, unqueue unsupported).
- `compose-state`/controller tests with the existing fake handle: Edit removed /
  not removed / error; Cancel removed / not removed; × with and without a turn;
  the field never holds a daemon-supplied text (mutation: feed `removed` an id
  with a different daemon text → field shows `own`'s).
- Agent `session.test.ts`: `unqueueAt` keeps texts and voice marks parallel.
- Daemon `hosted-session` tests: the parallel-queue proof (Load-bearing
  assumption); unqueue while idle / mid-turn / after drain / successor
  `messages` vs `steers`; `enqueued` kept (retry no-op); persisted state has
  the row gone (serve).
- `connection` test: `session/unqueue` routed, archived → `removed: []`.
- E2E flows updated; the `e2e-flows.test.ts` testID contract.

### Owner questions

1. **Split the daemon unqueue into its own task?** It touches the agent's
   steering queue and the protocol (load-bearing), the rest is mobile UI.
   *Recommendation:* yes — `feat/queue-unqueue` (S–M, load-bearing, Opus exec +
   fresh Review) lands first; this task stays M · cross-module for DeepSeek.
2. **Edit = withdraw at the tap** (the message is not queued while you edit; ×
   re-queues it at the END of the queue). *Recommendation:* yes — a half-edited
   message must not be read; with one pending message the position is the same.
3. **Other devices' rows:** pending bubbles labelled "another device", not
   tappable; their RETURNED rows keep a small Take card above the field.
   *Recommendation:* yes — the Take card is rare and needs an explicit act.
4. **Send now from the bubble menu also carries the text in the field?**
   *Recommendation:* no for the bubble (you tapped a message), yes for the
   in-field ⇥ Send now (today's behaviour).
5. **■ vs ↑ while running:** keep ↑ (queue) when text is typed and ■ only on an
   empty field, as the mockup draws, not "■ whenever running". *Recommendation:*
   yes — otherwise typed text could not be queued.
6. **Order:** start Execution only after fix/mobile-queued-stuck is merged.
   *Recommendation:* yes — a stuck row would become a stuck bubble.

## Execution

*(empty — awaiting approval)*

## Review

*(empty)*
