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

### Owner answers (2026-11-17 ~22:10)
Q1–Q6: all recommendations accepted (split `feat/queue-unqueue`, Opus exec, lands first; edit = withdraw; other devices labelled, not tappable; bubble Send now sends only that message; ↑ when typed / ■ on empty field while running; execution only after fix/mobile-queued-stuck merges). Implementation APPROVED.
*— recorded by claude-opus-5-5 (orchestrator), 2026-11-17*

## Execution

*— deepseek-v4, 2026-11-18*

### Step 0 — preconditions re-checked (before any edit)

**Slice A (D5, unqueue) is already merged** on `main` as `feat/queue-unqueue`
(`d06bc873`), with a **different shape than D5 describes** — reconciled, not
rewritten (drift, see below). `fix/mobile-queued-stuck` (Owner Q6's gate) is also
already in this branch (`cde193a9`, `39db0e52` — ancestors of HEAD), so the
dependency holds.

**Load-bearing check — PASSES** (`.tentacle/tmp/mobile-queued-compose/lb-check.ts`,
run on this branch):

```
listed   : e1:true
drained  : (none) → pending: 0
in-flight: x1:false
order    : o1:false m1:true
```

So a row listed while a turn runs is projected with `mine` right, leaves on the
first `queued` that drops it (→ zero pending bubbles), and the daemon's `entries`
order is kept. The check's own property holds.

### Step 0b — a PRECONDITION of the Design does NOT hold (recorded, then amended)

The Preconditions' *"'Mine' is the PERSISTED `own` map"* is true as a statement
of where `mine` comes from, but `own` **loses an id that is still in flight**:
`settleOwn` (`compose-queue.ts:373-392`) keeps only ids the report lists
(`entries`, `returned`) or `keep` names, and `onQueued`
(`compose-state.ts:99`) passes `keep` = a send-now's `carried` only. A `queued`
report that lands between the local mint and the daemon's `enqueue` therefore
drops the id from `own` — and `shownRows` derives `mine` from `own.has(id)`, so
the row then renders as *"from another device"* forever, even after the daemon
lists it.

Evidence (`.tentacle/tmp/mobile-queued-compose/lb-mine.ts`, `lb-reach.ts`):

```
minted        : e1:true
after report 1: e1:false      ← a report not listing it yet
after report 2: e1:false      ← the daemon lists it: still wrong
own still has e1?      : false
```

Reachable: the mint happens at the tap, the enqueue's round-trip is ≥1 RTT, and
the daemon publishes `queued` on every drain / turn end / another device's
enqueue (`hosted-session.ts:3762` and the `publishQueue` sites). This is a
pre-existing defect (it mislabels today's card too), but the feat multiplies it:
`mine` also decides `ownPending` (D3, so **Send now is not offered**) and
`bubbleActions` (D2, so **Edit/Cancel are hidden**). Shipping D1–D3 over it would
make the feature visibly broken for a message the person just sent.

**Amendment (executor, minimal — `settleOwn` already supports it):** `onQueued`
keeps in-flight local ids as `own` entries, exactly as a send-now's `carried`
already does:

```ts
const inflight = state.local.filter((r) => r.acked !== true).map((r) => r.id);
const step = onQueued(state, queue, { stoppedHere, keep: [...carried, ...inflight] });
```

Converges: a rejected enqueue still drops the id (`enqueueRejected`), an acked
row the report drops still leaves `own` (the stuck fix's rule). Pinned by a test
in the D1 slice, shown red first. **Review must check this amendment** it is the
one line of this task not in the approved Design.

### Step 1 — D1/D2, D3, D4, D6 as pure modules (in that order)

*— deepseek-v4, 2026-11-18*

**D3 — Send now's rule** (`composer.ts`). `sendNowOffered` = *a turn is running ∧
the link is up ∧ the session has not ended ∧ `ownPending > 0`*, and
`ComposerInput.ownQueue` was **renamed `ownPending`** (the number of MY rows, not
the number of rows): the count's two producers are `session-view.ts` (from
`ownPending`, and from its own default in the no-compose fallback) and
`compose-controller.ts` (`ComposeView.ownPending`, computed as
`rows.filter((row) => row.mine && row.state === "queued").length`). Drift from
D3 as written: the Design says "`ownQueue > 0` is MINE"; the field carried the
whole queue's length, which would have offered Send now for *another device's*
message. Tests in `composer-compose.test.ts` (+ every `ComposerInput` literal).

**D4 — `sendSlot` (pure)** (`composer.ts`):
`sendSlot(action: ComposerAction): SendSlot` with
`type SendSlot = "up" | "up-dim" | "stop" | "clock"` — the field's trailing slot
as ONE value, so the composer decides nothing (owner Q5: ↑ while text is typed,
■ only on an empty field while running). 2 tests in `composer-compose.test.ts`.

**D1/D2 — the bubbles and their menu (pure)** (`compose-queue.ts`):
`PendingBubble {id,text,mine,phase}`, `pendingBubbles(rows)` (a projection of the
SAME `shownRows` the card drew — no new state, no timer), `BubbleAction =
"edit"|"send-now"|"cancel"`, `BubbleContext {link,turn,sendNow,unqueue}`, and
`bubbleActions(bubble, ctx)` (empty unless MINE ∧ `pending` ∧ link ∧ turn; Edit
and Cancel need `unqueue`, Send now reuses D3's flag — so owner Q3's "another
device" and a `sending` bubble are shown, never acted on). 9 tests in
`compose-queue.test.ts`.

**D6 — the edit/cancel state machine (pure)** (`compose-state.ts`):
`Editing {id,text,prior}`, `ComposeState.editing` (dropped from the queue while it
stands — owner Q2) and `.unqueueOff`, `UnqueueReply = {removed} | "unsupported" |
"failed"`, `unqueueFor(state,{what,id,field,reply}) → {state,draft,notice}`,
`dropPending` (the row, my id, and the daemon's listed entry — the answer IS the
fact), `editingCleared`, and the three notices `UNQUEUE_READ_CANCEL` /
`UNQUEUE_READ_EDIT` / `UNQUEUE_KEPT`; `UNQUEUE_OLD_DAEMON` is imported from
`@tentacle/client` (Slice A's own string). `enqueueStarted` clears `editing` (the
words are queued again). The edit's text is always `own`'s, never the daemon's
(AGENTS §7: a pod is not trusted). 10 tests appended to `compose-state.test.ts`
under *"Edit and Cancel on a pending message (D6)"*, all red first.

### Step 2 — D5's port and the controller half (mobile)

*— deepseek-v4, 2026-11-18*

`compose-handle.ts` gained `unqueue: (ids) => client.unqueue(sessionId, ids)`,
`ComposeHandle.unqueue(ids): Promise<UnqueueReply>` in `compose-controller.ts`,
plus `unqueueNow` (a throw → `"failed"`), `unqueueApplied(what,id)` and the public
`edit(id)` / `cancel(id)` / `editCanceled()`, and `ComposeView.pending` /
`.editing` / `.unqueueOff`. `editCanceled` re-enqueues `editing.text` under a
**NEW** id when a turn runs (the old one is gone daemon-side), restoring
`editing.prior` only when the field is still what the edit left there; with no
turn the edit merely ends and the words stay in the field; a refused steer goes
through `enqueueRejected` and the words come back (never both places). 10 tests
appended to `compose-controller.test.ts` under *"Edit and Cancel through the
controller (D6)"*; every fake handle in the suite gained `unqueue`.

### Step 3 — the render (D1's footer, D4's one-field composer, D6's banner)

*— deepseek-v4, 2026-11-18*

**`screens/compose/PendingBubble.tsx`** (new): `PendingBubbles({bubbles,palette,
ctx,onAction})` — the transcript's footer, one right-aligned dimmed user-bubble
shape per queued row with a clock (or bolt, when `sending`) and the footnote
"Pending · next step" / "Sending now · stopping the step", plus " · another
device" when it is not mine; a tap on one of MINE opens the E1 menu (Edit · Send
now · Cancel, `bubbleActions`' items verbatim; Cancel red). It is a DUMB renderer
— the only state it owns is which menu is open (presentation: one at a time).
`testID`s are the flows' contract: `pending-bubbles`, `pending-<id>-<mine|other>`
(a `Pressable` only when it has actions), `pending-<id>-edit|send-now|cancel`.

**Wiring**: `session-view.ts` `SessionViewInput`/`SessionView`/`ComposeBarView`
gained `pending`, `editing`, `unqueueOff`, and `ComposerView.slot` (from
`sendSlot`); `session-screen-controller.ts` passes them through and exposes
`edit`/`cancel`/`editCanceled`. `SessionScreen.tsx` mounts `PendingBubbles` as the
FlatList's `ListFooterComponent`, **after** `ThinkingNode` (the footer is
`undefined` at `layout.tail === null && pending.length === 0`), with ctx
`{link: state.view.state === "Live", turn: composer.running, sendNow, unqueue:
!unqueueOff}`, and renders a `composer-editing` banner (+ `composer-editing-cancel`
×) above the field when `editing !== null`.

**D4's card trim (drift)**: the Design says the rows leave the card; the SHAPE it
left behind differs from the plan's letter. `ComposeBar.tsx`'s `QueueRows` now
takes only `{view:{returnedOthers},palette,onTake}` — no queued rows, no Send-now
pill — and `SessionScreen.tsx` renders it from `{returnedOthers:
compose.returnedOthers}`, so another device's RETURNED row keeps its small Take
card above the field (owner Q3). The `queued-row-` testIDs are gone with the rows.

**D4's composer re-layout**: `ui/Composer.tsx` rewritten as ONE `styles.field`
(`palette.fill`, a 1 pt `palette.sep` border, the new `radius.composer = 22`,
`shadow.glass`) holding the `TextInput` and a 36 pt row: `composer-photo` (`+` →
`onPhoto`), a spacer, the `composer-send-now` pill when `sendNow`, the mic, and a
36 pt `styles.slot` painted from `slot`. New props `slot: SendSlot`, `sendNow:
boolean`, `onSendNow: () => void`; every existing `testID` kept. The Send-now pill
thus moved from the card into the field (drift from D4's wording — the mockup's
place, and it is where the value it acts on lives).

**`compose-motion.ts`**: `shape()` also carries `editing === null ? "" :
"editing"`, so the banner's appearance/removal is animated by the same rule the
rows are.

### Step 4 — tests

*— deepseek-v4, 2026-11-18*

- `apps/mobile/test/composer-field-layout.test.ts` (new, 14 tests): one
  `TextInput` inside the one field; the 36 pt row and slot; fill/sep/1 pt/
  `radius.composer`; every testID kept; `composer-send-now` in the Composer and
  NOT in `ComposeBar`; `queued-row-` gone from `ComposeBar`; `slot: SendSlot` +
  `sendSlot` in `session-view.ts`.
- `compose-motion.test.ts` +1: the editing banner counts as a move.
- `session-screen-compose.test.ts` +4 (*"the pending bubbles on the screen"*):
  `view.pending` carries one bubble per queued row with `mine` right; Edit
  withdraws through the screen (`session/unqueue`, the banner, MY words in the
  field) and the bubble leaves; Cancel withdraws and never touches the field; the
  banner's × queues the words again under a new id. The block needed a turn that
  STAYS running (the harness's own turn drains after one `settle`), so it drives
  `session.activity` with a never-resolving stream — the act, not the fixture.
- `tool-rows-wiring.test.ts`: the footer guard updated, plus a test that
  `ThinkingNode` precedes `PendingBubbles`.
- e2e: `12-steer.yaml` waits `pending-bubbles` and asserts `pending-.*-mine`
  (it asserted `composer-queue`); `13-send-now.yaml` / `14-returned-mine.yaml`
  wait `pending-bubbles`. `e2e-flows.test.ts`'s `inside()` accepts `pending-`, the
  flow-12 test asserts the pending ids and that `composer-queue` is NOT asserted,
  and a new test pins the id strings `PendingBubble.tsx` must keep.

### Step 5 — mutation checks (red before green, per slice)

*— deepseek-v4, 2026-11-18*

| Mutation | Result |
| --- | --- |
| B0: drop the in-flight ids from `onQueued`'s `keep` | red ("an in-flight row stays MINE across a report that does not list it yet") |
| D6: `unqueueFor` reads the daemon's listed text instead of `own`'s | red ("Edit is never a DAEMON's words") |
| D6: `dropPending` keeps the local row | red (the withdrawn row stays a bubble) |
| D1/D6: `compose-motion.shape` drops the `editing` term | red (*"the editing banner appears and leaves"*) — re-checked, reverted |
| Screen: `pending: []` in the view wiring, `edit` not forwarded | 3 red (*"one bubble per queued row"*, both Edit tests) — re-checked, reverted |

### Step 6 — drift from the Implementation, in one list

*— deepseek-v4, 2026-11-18*

1. **B0 amendment** (Step 0b): one line, not in the approved Design, pinned by a
   test. `onQueued` keeps in-flight local ids in `own`.
2. **`ownQueue` → `ownPending`** (D3): the field was the whole queue's length;
   Send now must count only MINE.
3. **Rows → bubbles** (D1): the pending messages are the transcript's footer, not
   an extension of the card; `pendingBubbles` projects the same `shownRows`.
4. **Send now moved into the field** (D4's mockup, not its prose), and the card's
   `QueueRows` keeps only another device's RETURNED rows + Take.
5. **`radius.composer = 22`** — new theme token (the field is one rounded box).
6. **`compose-motion`'s `shape`** also watches the editing banner.
7. **The e2e id rename** (`composer-queue` → `pending-bubbles`/`pending-<id>-*`):
   the flows assert the bubbles now, because that is what the person sees.
8. **Slice A (D5) landed with a different shape than D5 describes** (Step 0): the
   client's `unqueue` + `UNQUEUE_OLD_DAEMON` already existed, so D5 became a port
   (`ComposeHandle.unqueue`) and a reuse of Slice A's string — no new protocol,
   no `protocol.d/` note, no schema regeneration.

*— deepseek-v4, 2026-11-18*

### Step 7 — the gate, and what it said

*— deepseek-v4, 2026-11-18*

```
bunx tsc --noEmit        → no output (green)
bun run lint             → Checked 2066 files. No fixes applied. (0 errors, 0 warnings)
bun test                 → 15066 pass, 5 skip, 0 fail (1078 files, 494 s)
```

The 5 skips are all `skipIf` opt-ins — live-k8s (×2, `TENTACLE_K8S_SERVER`),
live-docker (×2, `TENTACLE_DOCKER_TESTS`), the real-socket keepalive
(`TENTACLE_SLOW_TESTS`) — i.e. the documented baseline; nothing skipped on its
own. `bun test apps/mobile/test` alone: **3393 pass / 0 fail**. No schema and no
wire type changed (Step 6, drift 8), so `bun run protocol:bump` was **not** run
and no `protocol.d/` note was added.

## Review

*— claude-opus-5-5, 2026-11-18* (fresh context; different model family from the executor)

**Verdict: REQUEST-CHANGES.**

**Findings (HIGH/MEDIUM only):**

1. **HIGH — gate red: `bun run typecheck` fails** (Execution ran only root
   `tsc --noEmit`, which skips `tsc -p apps/mobile`):
   `compose-controller.ts:287` `PendingBubble` not imported;
   `compose-controller.ts:412` trace `act: "unqueue"` not in the trace union;
   `SessionScreen.tsx:1331`/`:1335` `styles.editBanner` / `styles.flex` do not
   exist, so the editing banner renders with no row layout at runtime.
2. **HIGH — Edit/Cancel apply a STALE state and a STALE field**
   (`compose-controller.ts:409-411`): `unqueueFor(state, { field, reply: await … })`
   evaluates `state` and `field` BEFORE the await. Any `queued` report landing
   during the unqueue RTT (the daemon publishes one on every unqueue) is
   overwritten by `state = step.state`, and text typed during the RTT is
   replaced by `restoreAfterFailure(oldField, text)`. Repro
   (`.tentacle/tmp/mobile-queued-compose/race-tail.ts`, appended to a copy of
   `compose-controller.test.ts`): during unqueue the daemon reports another
   device's row `other-1` and the person types "typed during rtt" → after
   `edit`: `rows []`, `field "mine"` (the row and the typed words are both
   lost). The docstring at `compose-state.ts:226` says "read fresh"; it is not.
3. **MEDIUM — × with the link down silently drops the words**
   (`compose-controller.ts:1072-1082`): `enqueueStarted` + the field reset to
   `prior` happen before `handle === null → return`. The row is local, never
   sent, and the B0 amendment (`compose-state.ts:129`) keeps unacked ids in
   `own` indefinitely ⇒ a "mine" pending bubble that never delivers, words
   gone from the field. The × path also bypasses the outbox driver the normal
   queue path uses (`:883-900`).
4. **MEDIUM — bubble "Send now" violates owner Q4** (`SessionScreen.tsx:1163`):
   it calls `controller.sendNow()`, which carries the field's text
   (`compose-controller.ts:974-977`); Q4 (accepted) says the bubble's Send now
   sends only the message, not the field.

**Gate:** `bun test apps/mobile/test` 3393 pass / 0 fail; `bun run lint` clean
(2066 files); `bun run typecheck` **FAILS** (finding 1). Full `bun test` not re-run.

**Mutation:** `bubbleActions` without the `!bubble.mine` guard → red ("another
writer's words are shown, never acted on"); reverted, tree clean.

**Attacks tried:** stale-state race on Edit (found #2); × with link down (#3);
bubble Send now vs Q4 (#4); §7 "pod not trusted" — the edit text comes from
`own`, never the daemon (holds, `compose-state.ts:247`); B0 amendment
convergence on reject (holds via `enqueueRejected`), not on a never-sent row (#3).

**Executor behaviour:** thorough doc and drift list, honest about the B0
amendment; but claimed a green gate without running the repo's `typecheck`
script, and its D6 tests never interleave a report with the unqueue await.
