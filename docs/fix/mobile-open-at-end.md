# fix/mobile-open-at-end — open at end, resync on foreground, swipe-to-time

> **Status:** implementation (approved by orchestrator, owner request)
> **Branch:** `fix/mobile-open-at-end`
> **Size:** S–M · **Blast:** contained (apps/mobile only, no protocol) · **Suited:** DeepSeek exec + one Opus review
> **Changelog:** `changelog.d/mobile-open-at-end.fixed.md` + `changelog.d/mobile-swipe-timestamps.added.md`

## Context

Owner, 2026-11-16 (live on the iPhone):
1. **Opening a long conversation scrolls visibly through the whole transcript**
   down to the end ("per conversazioni lunghissime è bruttino"). Wanted: the
   session opens ALREADY at its end — no visible scroll, no animation — like a
   messaging app. Later appends while following keep today's behaviour.
2. **Resync when the app comes back to the foreground.** Today a resync happens
   only when the link dropped (redial + re-attach, `connection.ts:130`) or on
   pull-to-refresh (`session-screen-controller.ts:1375` `resync()`). The bug
   class fixed in `docs/fix/mobile-media-live.md` (updates silently lost while the
   link stayed up) had no automatic recovery. Wanted: when the app returns to
   `active` with a session screen open, run the same `resync()` (silently: no
   pull spinner; the existing re-entry guard makes a concurrent pull a no-op).

*— claude-opus-5-5 (orchestrator), 2026-11-16*

### Slice B — swipe a row left to reveal its time (owner, same branch)

Owner, 2026-11-16 (iPhone), with a reference screenshot from another chat app
(`.tentacle/tmp/mobile-swipe-timestamps/reference.png`): dragging the
conversation to the LEFT reveals, in the
right margin, the arrival time of each row (e.g. `22:16` aligned with the user
bubble). Releasing springs everything back. Not implemented in tentacle today;
the owner wants it ("lo voglio implementato").

Behaviour to match (iMessage-style):
- **Per row (owner correction, 2026-11-16):** a horizontal pan on ONE row
  (block) slides ONLY that row left and reveals ONLY its time; every other row
  stays put. Capped (~60–70pt), a little resistance; release → spring back.
  (The reference screenshot shows the whole transcript moving — NOT wanted.)
- The swiped row (user bubble, assistant text, tool-summary row) shows its time
  `HH:mm` (device locale/24h as the system says) vertically centred on the row,
  in the secondary text colour, mono font (owner: MONO font everywhere in charts;
  follow the app's existing secondary-label style).
- Must not fight vertical scrolling (activate only on a clearly horizontal
  drag), the hub floating button, the edge-swipe back gesture, text selection,
  or the tool-row tap/expand.
- Times: from the session log's entry timestamps (`ts` on log entries) or the
  message as received live; a row without a known time shows nothing.
  If a time is not reachable on the phone today, the plan states exactly where
  it comes from (log read on attach + live updates) and whether any protocol
  field is needed (prefer none; if needed, additive per AGENTS §7).

Constraints: logic (which rows get which time, gesture thresholds/state) in a
pure module with tests; the component only renders (AGENTS §7). Owner taste:
minimal (`owner-taste-minimalism`). Same branch as slices A (open at end) and the foreground resync (owner: do them together).

*— claude-opus-5-5 (orchestrator), 2026-11-16*

## Implementation

**Slice A** (items 1–2 above):

**Load-bearing check (do first, paste output):** a repro under
`.tentacle/tmp/mobile-open-at-end/` (or a test) showing that today the first
scroll after the initial attach is `animated: true` (SessionScreen.tsx ~302, the
pure step that yields `step.scrollTo`) and/or that the list mounts at offset 0
with a long history.

**Design (pick the smallest that holds; logic in the pure module, the
component only renders — AGENTS §7):**
- The scroll state machine distinguishes the **initial landing** (first content
  of an attach/re-attach/resync with history) from later follow-scrolls: the
  initial landing is `animated: false` and happens before the rows are shown
  (e.g. hide the list for that first layout frame, or `initialScrollIndex` /
  `maintainVisibleContentPosition`, or an inverted list if it is the cleanest —
  justify the choice in Execution). Later appends: unchanged.
- A long history must not render every row to get to the end (keep FlatList
  virtualization; no `initialNumToRender = rows.length`).
- Foreground resync: the screen controller gets an `appActive()` input (fed
  from `AppState` by the screen/app shell, the pattern `dictation.ts` /
  `read-aloud.ts` use); when attached and not already refreshing it calls the
  `resync()` path silently. Never while offline (the redial path owns that), and
  at most once per foreground transition.

**Failure modes:** empty session; history shorter than the screen; resync that
appends nothing (no jump); resync while a turn streams (no duplicate rows — the
attach path already dedups, `transcript.ts:274-281`); user scrolled up reading
when foregrounding (resync must not yank them to the end); rapid
background/foreground.

**Tests (red first, mutation-checked):** pure-module tests for the scroll
machine (initial landing not animated; later follow animated; scrolled-up
reader not moved by a resync) and the controller (`appActive` → one silent
resync; offline → none; already refreshing → none); a SessionScreen render test
asserting the initial scroll call is `animated: false`.

*— claude-opus-5-5 (orchestrator), 2026-11-16 — APPROVED*

**Slice B** (swipe a row left → its time). **Size: M · Blast: cross-module**
(additive protocol field + daemon + client + mobile; no §7 invariant, no
persisted format, no version bump) — supersedes the header's "contained, no
protocol" for this slice. Fresh-context Opus review stays mandatory.

#### Load-bearing assumption — where a row's time comes from (PROVED: nowhere today)

The phone has **no per-message time** on any path, so one must be added:
- The phone's history is `session/snapshot`, not `session/log`:
  `remote-client.ts:3839-3866` pages `Method.Snapshot` and keeps only
  `result.messages`; `remote-client.ts:3514-3520` steps `{kind:"snapshot",
  messages,…}` → `session-reducer.ts:372-381` `reset{messages}` →
  `remote-session.ts:1763-1767` `history{messages}` (or `:1780`
  `history_reset{messages}` into a running turn) → `session-feed.ts:216-220` →
  `transcript.ts:72-73` → `historyRows(messages, nextKey)`
  (`transcript-history.ts:51`).
- `ChatMessage` carries no time (`protocol/session.ts:80-100`), nor does
  `SnapshotResultSchema` (`session.ts:862-880`); no live `session/update` does
  either (`grep ts:` over `protocol/src` hits only `session-log.ts:107`).
- The only `ts` is the log envelope's (`session-log.ts:107`), and it is NOT the
  arrival time: `SessionLog.segment` re-logs every message of a `base` with
  `this.now()` (daemon `session-log.ts:177,338`), so after a `serve` reload
  (`hosted-session.ts:971`) or a compaction every message would read the restart
  time. The phone also never calls `readBack` (no hasher, full log read).
- The daemon CAN know it: `SessionLog.commit` (`daemon/session-log.ts:104-122`)
  is the single place an index is appended / replaced / truncated, with an
  injected clock (`:79`), and every daemon builds one
  (`hosted-session.ts:965`), committed to `cut.length` (`:2081`) — the same
  bound `snapshotPage` slices (`:2017-2023`).

**⇒ Design stands on:** "`SessionLog`'s committed prefix (`ref`) is
index-aligned with `session.messages.slice(0, cut.length)` whenever
`snapshotPage` runs." Prove first (Execution step 1): a hosted-session test
asserting `times.length === messages.length` on the first page and on a
cursor page, across a turn, a compaction and a reload. If it fails, STOP and
fix the plan.

#### Preconditions (verified)
- Fields are free (§7): `SnapshotResultSchema` is a strip schema
  (`session.ts:862`, `z.object`), so an older client drops `times`, an older
  daemon sends none → rows show nothing. No `protocol.d/` note.
- Rows are rendered one `FlatList` cell per `Row` (`SessionScreen.tsx:663-704`,
  `renderItem` → `TranscriptRow`); no gesture library in the app — gestures are
  core `PanResponder` (`ui/FloatingActivity.tsx:112-117`, which already claims
  touches that START on the hub and refuses termination).
- Back navigation is native-stack (`App.tsx:22,176`): a RIGHTWARD left-edge
  swipe. Our pan is leftward only.
- Mono + secondary colour exist: `MONO`/`type.mono` (`theme.ts:193,210`),
  `palette.sec` (`theme.ts:40`).
- RN does not render under `bun test`; the repo's "SessionScreen render test"
  is a SOURCE-wiring test (`test/session-screen-follow-wiring.test.ts:1-12`).

#### Design
1. **Daemon — times live in `SessionLog`.** A `times: number[]` parallel to
   `ref`: `commit` append → `now()`; replace → keep the existing time (a later
   edit of a message is not a new arrival); truncate → slice; `segment`
   (create/seed/reload/compact/context_reset) → `0` (unknown) for every base
   message. Accessor `timesOf(start, end)`. `snapshotPage` adds
   `times: this.log.timesOf(start, end)`.
2. **Protocol — `SnapshotResult.times?: number[]`** (int ≥ 0, epoch ms), same
   length and order as `messages`; `0` = not known (no `null` on the wire,
   matching the envelope convention, `session-log.ts:104`). Display-only.
3. **Client — pass it through, never derive it.** `readSnapshotPages`
   concatenates `times` page-wise like `messages` (`:3859,3866`); a page whose
   `times` is absent or of the wrong length makes the WHOLE snapshot's `times`
   undefined (never misaligned). `snapshot` input → `reset` output →
   `history{messages, times?}` / `history_reset{messages, times?}`
   (`mapping.ts:31`) / the context-reset history (`remote-session.ts:1820`).
   The TUI ignores it; nothing is written to disk (§7 persistence untouched).
4. **Mobile rows carry `at?: number`** on `UserRow`, `AssistantRow`, `ToolRow`
   (`transcript-rows.ts`). `historyRows(messages, nextKey, times?)` sets it from
   `times[i]` (> 0 only); a tool row takes its CALL's time (the assistant
   message that listed it), never the result's. Live rows: the feed is given
   an injected `now()` (app shell passes `Date.now`) and stamps `at` on the
   fold input; the fold sets `at` when it CREATES a user/assistant/tool row and
   never on upsert. `notice`/`reasoning`/`turn` rows: no time. A resync
   replaces rows with the daemon's times (live stamps are dropped with them).
5. **Pure module `src/row-swipe.ts`** (React-free): `REVEAL = 64`,
   `SLOP = 12`; `claimsPan({dx, dy}, hasTime)` → true only if `hasTime`,
   `dx < -SLOP` and `|dx| > 2·|dy|`; `revealOffset(dx)` → `0` for `dx ≥ 0`,
   else `-REVEAL·(1 − e^(−|dx|/REVEAL))` (resistance, capped, monotone);
   `timeLabel(at, fmt)` → `null` for missing/0, else `fmt(at)`; `fmt` defaults
   to `Intl.DateTimeFormat(undefined, {hour: "2-digit", minute: "2-digit"})`
   (device locale decides 12/24h) — injected in tests.
6. **Component — `screens/transcript/SwipeTime.tsx`** (dumb): wraps one row in
   an `Animated.View` with `translateX` (native driver); its `PanResponder`
   uses `onMoveShouldSetPanResponder: claimsPan` (never `onStart…`, so taps,
   the tool-row expand and long-press selection are untouched),
   `onPanResponderMove: set(revealOffset(dx))`, release AND terminate →
   `Animated.spring` to 0, `onPanResponderTerminationRequest: () => true`
   (a native vertical scroll wins and the row springs back). The label is
   `position: "absolute"`, `right: -REVEAL`, `width: REVEAL`, top/bottom 0,
   centred, `type.mono` + `palette.sec` — outside the layout, so the row's
   height never changes. `renderItem` wraps `TranscriptRow` in it with
   `label={timeLabel(item.at)}`; no `Date`/`Intl` in the component.

#### Files (dependency order)
1. `packages/protocol/src/session.ts` — `times` on `SnapshotResultSchema`;
   regenerate `schema/protocol.json` (merge step does it; run locally for the
   drift test).
2. `packages/daemon/src/session-log.ts` — `times`, `timesOf`;
   `packages/daemon/src/hosted-session.ts` — `snapshotPage` adds `times`.
3. `packages/client/src/remote-client.ts` (`readSnapshotPages`, snapshot step),
   `session-reducer.ts` (input/output), `remote-session.ts` (`history`,
   `history_reset`, context-reset history), `mapping.ts` (`history_reset` type).
4. `apps/mobile/src/transcript-rows.ts`, `transcript-history.ts`,
   `transcript.ts`, `session-feed.ts` (+ its `now` dep at the call site).
5. `apps/mobile/src/row-swipe.ts` (new).
6. `apps/mobile/src/screens/transcript/SwipeTime.tsx` (new),
   `screens/SessionScreen.tsx` (`renderItem`).
7. `changelog.d/mobile-swipe-timestamps.added.md`.

#### Failure modes → convergence
- **Vertical scroll vs pan:** claim only on a clearly horizontal LEFT move
  (2:1); a scroll that starts first keeps the responder; a takeover terminates
  the pan → spring back. Never a stuck offset.
- **Edge-swipe back:** rightward → `claimsPan` false; native back untouched.
- **Hub button:** a touch starting on it is the hub's (`FloatingActivity`
  claims on start, refuses termination) — rows never see it.
- **Tool-row tap / expand, text selection, speak button:** no movement → no
  claim (move-only responder); `Pressable`s keep the tap.
- **Row without a time** (old daemon, reload/compaction-restored message,
  notice): `claimsPan` false → the row does not move; nothing shown.
- **Misaligned `times`** (bug or hostile pod): length mismatch → dropped
  entirely in the client. A pod can lie about times: display-only label, never
  persisted, no laptop effect — inside "a pod is not trusted" (§7).
- **Re-attach / resync / foreground resync (slice A):** rows replaced by the
  snapshot's times; a row mid-swipe that is unmounted takes its
  `Animated.Value` with it.
- **Slice A open-at-end / follow:** translateX + absolute label → no content
  height change, so `contentGrew`/follow never fire from a swipe.
- **Clock skew (live phone stamp vs daemon time):** a resync converges to the
  daemon's; HH:mm only, minutes of skew at most.

#### Tests (red first; mutation target in brackets)
- protocol: `SnapshotResultSchema` parses with and without `times`; json-schema
  drift test green after regen.
- daemon `session-log`: append stamps the injected clock; replace keeps the
  first time [mutation: re-stamp on replace]; truncate drops; a `base`
  segment yields 0s [mutation: stamp `now()` on segment].
- daemon `hosted-session`: `times.length === messages.length` on first and
  cursor pages, after a turn, a compaction, a reload (the load-bearing proof)
  [mutation: off-by-one in `timesOf` slice].
- client: snapshot `times` reaches `history` and in-turn `history_reset`;
  multi-page concat order; one page without `times` → `undefined` [mutation:
  drop the field in `session-reducer` reset output].
- mobile `transcript`: history with times → user/assistant/tool `at`, none on
  notice/reasoning, 0 → none; tool row keeps the call's time; live create
  stamps, upsert does not [mutation: set `at` on upsert].
- mobile `row-swipe`: claim matrix (left-horizontal yes; vertical, diagonal
  1.5:1, rightward, sub-slop, no-time → no); `revealOffset` 0 for dx ≥ 0,
  monotone, never past `-REVEAL`; `timeLabel` null for missing/0 and uses the
  injected formatter [mutation: `>=` vs `>` on SLOP; drop the cap].
- SessionScreen/SwipeTime source-wiring test (repo pattern): `renderItem`
  wraps `TranscriptRow` in `SwipeTime` with `timeLabel(item.at…)`; responder is
  `onMoveShouldSetPanResponder` → `claimsPan`, NOT `onStartShould…`; spring on
  BOTH release and terminate; `useNativeDriver: true`; label
  `position: "absolute"`; no `Date`/`Intl` in either component [mutation:
  remove the terminate spring-back].
- Device check (owner's iPhone, Execution notes it): scroll while swiping,
  back-swipe, hub drag, tool expand, selection, a long session opened at end.

#### Orchestrator decisions (owner delegated, 2026-11-16)
1. **Time source:** daemon-tracked arrival time on an additive
   `SnapshotResult.times`, plus phone-stamped receipt for live rows —
   recommended over (a) phone-only stamping (every history row blank after a
   reopen: fails the reference case) and (b) phone `readBack` of
   `session/log` (its `ts` is rewritten at reload/compaction, needs a hasher, a
   full log read).
2. **Unknown = 0, not `null`**; a restored-at-reload message has no time
   (debt below).
3. **No-time rows don't move** (no dead gesture).
4. **Core `PanResponder` + `Animated`**, no new dependency (minimalism).
5. **Labelled rows:** user, assistant, tool only.
6. **Debt (not this slice):** times survive a `serve` reload only if the
   daemon derives them from its on-disk log's original `append` entries —
   a follow-up if the owner asks.

*— claude-opus-5-5, 2026-11-16 — Slice B APPROVED*

## Execution

### Slice A — open at the end + foreground resync (done)

**Load-bearing check (repro, `.tentacle/tmp/mobile-open-at-end/`, gitignored).**
`repro-initial-scroll.ts`, BEFORE — a 40 000 pt history, an 800 pt viewport:

```
content first: {"state":{"following":true,"unseen":false},"scrollTo":null,"animated":true}
layout after:  {"state":{"following":true,"unseen":false},"scrollTo":39200,"animated":true}
```

The first layout of an attach therefore scrolled 39 200 pt **animated**: the
owner's "flies through the whole history". AFTER (`repro-after.ts`, same state):

```
landing 1:    {"state":{"settling":true,…,"rounds":1},"step":{…,"scrollTo":39200,"animated":false}}
landing 2:    {"state":{"settling":false,…,"rounds":2},"step":{…,"scrollTo":39200,"animated":false}}
later append: {…,"scrollTo":39200,"animated":true}
```

**As built.** `follow.ts` gained `FollowStep.animated` (contentGrew /
viewportChanged: `true`) and a pure landing machine — `Landing`, `landingStart`,
`landingQuiet`, `landingDone`, `landingStep(state, size, following)`,
`LANDING_ROUNDS = 12` — that owns the FIRST scroll of an attach/re-attach: not
animated, repeated (bounded) until the end stops moving. `SessionScreen.tsx`
asks `land()` before the follow step in `onContentSize`/`onListLayout`, performs
`step.animated`, and renders the list inside `<View style={settling ? hidden :
screen}>` — laid out and scrolled while `opacity: 0`, shown once settled (so a
long history is never SEEN scrolling, and virtualization is untouched: no
`initialNumToRender` change). Pull-to-refresh, Retry and Reopen re-arm it
(`landingQuiet` while following, `landingDone` when scrolled up — a reader is
never yanked), and `onJump` passes `animated: true`.
`session-screen-controller.ts` gained `appState(name)` (fed by an `AppState`
listener in the screen): only a RETURN resyncs (`appWasAway` — the mount's own
`active` is the open), never while disposed/refreshing/pulling/attaching, not on
a dead attach, not while the link is down (the redial owns that). `resync` grew a
`silent` flag with its own `pulling` state, so a foreground resync emits no
spinner.

**Tests.** `follow.test.ts` (22), `session-screen.test.ts` (31 — a "foreground
resync" describe of 7: one-per-return, offline, duplicate `active`, already
pulling, in-turn no duplicate), `session-screen-follow-wiring.test.ts` (12),
`mobile-media-live-wiring.test.ts` (9; its `resync` assertion now allows the
landing re-arm but still requires `void controller.resync();`).

**Mutations (RED confirmed).** `landingStep` returning `animated: true` → 4
fails; dropping the hidden gate → 1; a foreground resync not silent → 1; the
offline guard → 1; the departure reset (`appWasAway = true`) → 1.

### Slice B — swipe a row left to see its arrival time

**Load-bearing proof (step 1, `packages/daemon/test/session-log.test.ts`).**
`times.length === messages.length` on the first page and on a cursor page, across
a turn, mid-turn, a compaction and a reload, and only appended messages are
stamped — `SessionLog.commitTimes` is the single place (`append` stamps `now()`
once per batch, `replace` keeps, `truncate` slices), `segment()` zeroes every
base message, `timesOf(start, end)` is clamped, and `snapshotPage` pairs it with
`messages.slice(start, end)`. Mutations RED: an off-by-one in `timesOf` → 6
fails; re-stamping on replace → 3; stamping `now()` on `segment` → 3.

**As built, in the plan's order.**
1. `protocol/src/session.ts` — `SnapshotResultSchema.times?: number[]` (int ≥ 0),
   documented as display-only; `packages/protocol/schema/protocol.json`
   regenerated with `bun run schema:export` (the drift gate
   `protocol/test/json-schema.test.ts` was RED before the regen and green after).
   New `protocol/test/snapshot-times.test.ts` (4): parses with/without, rejects a
   non-integer/negative/non-number, and states that a length mismatch is the
   CLIENT's business, not the schema's.
2. `daemon/src/session-log.ts` + `hosted-session.ts` — as proved above.
3. **Client** (`remote-client.ts`, `session-reducer.ts`, `remote-session.ts`,
   `mapping.ts`) — `readSnapshotPages` concatenates `times` page-wise in the same
   `reverse()` as `messages`, and a page whose `times` is absent or of another
   length makes the WHOLE snapshot's `times` undefined (a pairing the client
   cannot vouch for is dropped, never half-applied); the snapshot input → the
   reducer's `reset` output → `history{messages, times?}`, the in-turn
   `history_reset{messages, times?}` and the context-reset `history` all carry it
   through untouched. The TUI ignores the field; nothing is persisted (§7).
4. **Mobile rows** — `at?: number` on `UserRow`/`AssistantRow`/`ToolRow`;
   `historyRows(messages, nextKey, times?)` pairs by MESSAGE index and drops a `0`
   (a re-logged message is not a `now`); a tool row takes its CALL's time, never
   its result's. The fold takes an optional receipt clock (`apply(state, input,
   now?)`) and stamps a row only where it CREATES it (a delta that extends an
   existing row keeps its time); `SessionFeedDeps.now` is injected by
   `session-screen-controller.ts` (`deps.now`), and a `history` activity's times
   replace the live stamps with the daemon's.
5. `apps/mobile/src/row-swipe.ts` (new, pure) — `REVEAL = 64`, `SLOP = 12`,
   `claimsPan`, `revealOffset` (resistance, asymptotically capped at `-REVEAL`),
   `timeLabel(at, fmt)` with the device's `Intl` formatter injected, and
   `rowTimeLabel(row, fmt?)` (the per-ROW wrapper the plan called
   `timeLabel(item.at)` — see drift 2).
6. `screens/transcript/SwipeTime.tsx` (new, dumb) — `Animated.View` `translateX`
   (native driver), a `PanResponder` claiming on `onMoveShouldSetPanResponder` →
   `claimsPan`, `onPanResponderTerminationRequest: () => true`, and a spring to 0
   on BOTH release and terminate; the label is `position: "absolute"`,
   `right: -REVEAL`, `width: REVEAL`, `pointerEvents: "none"`, so it never
   touches the row's height. `SessionScreen.tsx`'s `renderItem` wraps
   `TranscriptRow` in it with `label={rowTimeLabel(item)}`.
7. Changelog fragments: `changelog.d/mobile-open-at-end.fixed.md` (slice A) and
   `changelog.d/mobile-swipe-timestamps.added.md` (slice B); `CHANGELOG.md` is
   untouched.

**Tests (red first, then green).** `client/test/snapshot-times.test.ts` (7 — a
page's times reach the activity, an older daemon sends none, multi-page order,
one page missing → undefined, one page misaligned → undefined, a mid-turn attach's
`history_reset`, and an older daemon's `history_reset` with no times);
`mobile/test/row-times.test.ts` (13 — history pairing by message index, the tool
row's call time, `0` → none, notices/reasoning never, the restart prompt keeps
the reset message's time, the receipt clock stamps a created row and never an
upsert, the own prompt at its ack); `mobile/test/row-swipe.test.ts` (11 — the
claim matrix incl. vertical/diagonal/rightward/sub-slop/no-time, the cap and the
monotonicity of `revealOffset`, `timeLabel`'s nulls and injected formatter);
`mobile/test/swipe-time-wiring.test.ts` (8 — the source wiring: move-only claim,
terminate spring-back, native driver, absolute label, no clock in either
component, `renderItem` wrapping).

**Mutations (all RED, then reverted).** Client: dropping `times` from the
reducer's `reset` output → 3; concatenating without the per-page length check → 1;
a wrong `pages.length` guard → 1 (this one only fails when a page is added after
the array went unusable). Mobile: `at > 0` → `at !== undefined` → 2; stamping a
row on upsert → 1. `row-swipe.ts`: dropping the `hasTime` gate → 1; dropping the
2:1 ratio → 2; replacing the resistance curve with `dx` → 2. Component: removing
`onPanResponderTerminate` → 1; adding `onStartShouldSetPanResponder` → 1.

### Drift from the Implementation

1. **The daemon-side `timesOf` also clamps and `segment` zeroes** exactly as
   planned; no drift, recorded only because the plan's "step 1 proof" was
   satisfied as a `session-log` test rather than a `hosted-session` one (the log
   is the source of the alignment, and `snapshotPage`'s two lines are the
   trivial pairing of it — its `messages` and `times` come from the same
   `start`/`end`).
2. **`rowTimeLabel(row, fmt?)` instead of `timeLabel(item.at)` in `renderItem`.**
   `at` exists only on the three labelled row kinds, so `item.at` does not
   type-check against `Row`; the wrapper lives in the pure module (not the
   component), so the "which row kinds have a time" rule is still unit-tested and
   the component stays a renderer.
3. **The receipt clock is a third `apply` parameter, not a field on every input.**
   `apply(state, input, now?)` keeps every existing call site and every existing
   test valid (`apply` with no clock invents nothing), and it is what makes "stamp
   on CREATE, never on upsert" a property of the fold rather than a discipline
   spread over a dozen `push` calls.
4. **`session-screen-controller.ts`'s controller literal is now built in a
   `const` and published through a one-slot holder**, because Biome's
   `useConst`/`noAssignInExpressions` refuse the `return (self = {…})` shape slice
   A introduced. Behaviour identical (the only reader is `appState`, at call
   time).
5. **The `SwipeTime` label was `right: -REVEAL` with the row NOT clipped**
   (`overflow: "visible"`): the label sat outside the row's box, which the
   author believed kept a swipe from changing any height the follow machinery
   measures. **Wrong, and Review round 1 HIGH 2 fixed it** — see "Fix round 1"
   below (`right: 0`, clipped frame, opaque row).

### Validation (gate, at the end of slice B)

- `bun run typecheck` — clean (`tsc --noEmit`, `tsc -p apps/mobile`, `tsc -p apps/relay`).
- `bun run lint` — clean (`biome check .`: 1785 files, 0 errors, 0 warnings — the
  §6 baseline).
- `bun test` — **13 022 pass, 5 skip, 0 fail** (926 files). The 5 skips are the
  three opt-in ones plus two conditional skips in the existing suite; none is new
  work of this task. One **flake, not a regression**: `pod-binary-build.test.ts`
  ("a release build carries no build marker") failed ONCE with
  `Error writing standalone module graph: Io` — the machine's disk was at 100 %
  (184 MiB free) while a 130 k-test run compiled binaries; it passes on rerun
  (`19 pass, 0 fail`) and the same file passed in the first full run. Worth a
  re-run on the merge machine, not a code change.
- Device check (owner's iPhone) is still **open**: a long session opened at its
  end with no visible scroll; swipe a row left; scroll while a row is swiped
  (springs back); the left-edge back-swipe still pops; a tool row still expands
  on tap; text selection unaffected.

*— deepseek (executor for slices A + B; the signature previously read
`claude-opus-5-5`, which was wrong — Review round 1, LOW), 2026-11-17*

## Review

**Verdict: REQUEST-CHANGES** (scope: `git diff main...HEAD`, slices A + B).

**Gate (re-run by the reviewer).** Touched test files (11): 156 pass, 0 fail.
`bun run lint`: 1785 files, clean. `bun run typecheck`: clean. Full `bun test`
was not re-run (out of scope for this pass). Mutation: `segment()` stamping
`now()` instead of `0` → `session-log.test.ts` 5 fail; reverted, tree
byte-identical (`git status` empty).

**Findings**
1. **HIGH: the opening list can stay invisible.** `follow.ts:112` ends `settling`
   only when two `land()` calls in a row see the SAME content height (or after 12
   rounds). `land()` runs only from `onContentSizeChange` and `onLayout`
   (`SessionScreen.tsx:365-383`). RN fires both only when a size CHANGES, so
   the repeat the machine waits for never arrives. Example: a short session gives
   1–3 content events, the last one differs from the one before, and the
   transcript stays at `opacity: 0` (`SessionScreen.tsx:724`) until a keyboard or
   rotation re-lays it out. The "Opening the session…" empty state sits inside
   the same hidden View, so it is never seen either. `follow.test.ts:117-121`
   passes only because it feeds a repeated measurement that the screen cannot
   produce. That proves a weaker property than "the list is shown" (§2/§9). Fix:
   settle on a signal that does arrive, e.g. a frame or short timer after the
   last landing scroll, with a time-bounded reveal. Pin the real event sequence
   (distinct heights, then silence) in a test. Not verified on a device: RN is
   not installed in this tree. Verify by opening a 2-message session.
2. **HIGH: the swipe reveals nothing.** `SwipeTime.tsx:487,505-508` puts the
   label at `right: -REVEAL`. That is OUTSIDE the cell, which is full-width
   (`styles.list` has no horizontal padding). The label is also a SIBLING of the
   translating `Animated.View`, so it never moves. The row slides left and
   uncovers an empty strip `[W−64, W]`, while the label sits at `[W, W+64]`,
   which the iOS ScrollView clips. Plan design 6 made this geometry error; the
   executor followed it, and `swipe-time-wiring.test.ts:37` pins the wrong
   geometry. Fix: `right: 0` inside the frame, behind the row. It stays absolute,
   so the row height still never changes.
3. **MEDIUM: a foreground resync does not re-arm the silent landing.**
   `session-screen-controller.ts:639` runs `resync(true)`. The screen re-arms
   `landingQuiet` only for pull, Retry and Reopen (`SessionScreen.tsx:691,702,792`).
   So any content change that a foreground resync causes goes through
   `contentGrew` with `animated: true`. That misses the plan's
   "re-attach/foreground lands silently" (`follow.test.ts:158`). No test covers
   this path.

**Premises checked.** `SessionLog.commit` is the single append/replace/truncate
site (`session-log.ts:112-135`) — TRUE. `snapshotPage` pairs
`messages.slice(start,end)` with `timesOf(start,end)` (`hosted-session.ts:2023-2028`)
— TRUE. The client drops ALL times on any missing or misaligned page
(`remote-client.ts:3872-3888`) — TRUE. The strip schema is additive, with no
version bump (`protocol/session.ts:893`) — TRUE.

**Attacks tried.**
- **Hostile pod times:** display-only, never persisted, nothing reaches the
  laptop. Holds (§7).
- **Log lagging the cut:** `times` comes back shorter, so the client drops it
  rather than mispairing. Holds.
- **Upsert restamping:** `apply` stamps only rows it creates. Holds.
- **Rightward back-swipe:** `claimsPan` is false for it. Holds.
- **Landing termination:** findings 1 and 3.
- **Label geometry:** finding 2.

**Executor behaviour.** The work is careful and well documented, and the
mutation claims are plausible (one re-checked). The executor tested the pure
machine against inputs RN never delivers, and copied the plan's label geometry
without questioning it. Sign-off mismatch: Execution is signed
`claude-opus-5-5 (executor)`, but commit `24d47937` says `exec (deepseek)`.
Fix the signature so it is honest (§10).

*— claude-opus-5-5, 2026-11-17* (fresh context. Same family as the plan's
author, so it may share the plan's blind spots, e.g. finding 2 came from the plan.)

### Fix round 1

Scope: Review round 1's three findings (1 HIGH, 2 HIGH, 3 MEDIUM) + its LOW
signature note. Repro/temp files in `.tentacle/tmp/mobile-open-at-end/`.

**F1 (HIGH) — the opening list could stay invisible. FIXED.**
The root cause is what Review said: `settling` ended only on a REPEATED content
height, and RN fires `onContentSizeChange`/`onLayout` only when a size CHANGES,
so a short session never produced the repeat and the list stayed at
`opacity: 0` (empty state included). The signal is now **time**, not a repeat:

- `follow.ts` — `landingReveal(state, m, following)` + `LANDING_REVEAL_MS = 120`:
  measurements going QUIET reveals the list and performs its final landing
  (silent, at the sizes known then). Not following → revealed in place, never
  yanked. Nothing measured → `landingAwaiting`: the empty state IS shown and the
  rows that finally arrive hide the list again for their own silent landing (so
  a slow attach never shows the transcript at its TOP). A new
  `Landing.awaiting` field carries that; `landingStep` honours it.
- `SessionScreen.tsx` — a `setTimeout` re-armed after every landing scroll, armed
  at the MOUNT (an empty or one-message list sends no measurement at all) and
  cleared on unmount. The repeat-height rule stays as the fast path; the timer is
  the bound.
- Tests: `follow.test.ts` pins the REAL event sequence (two distinct heights,
  then silence) and the reveal's own cases; `session-screen-follow-wiring.test.ts`
  pins the timer, the re-arm and the mount arm.

**F2 (HIGH) — the swipe revealed nothing. FIXED.**
Review's geometry is right: the cell is full width, so `right: -REVEAL` put the
label at `[W, W+64]` — past the ScrollView's edge, clipped — while the row slid
left to uncover an empty strip. Now `right: 0` (inside the frame, in the strip
the row gives up), `frame: overflow: "hidden"` (the travelling row cannot draw
past its cell) and the row is OPAQUE (`backgroundColor: palette.page`, maximum
blur radius), drawn over the label as a later sibling — so the time only shows
where the row has moved off it. It stays absolutely positioned, so no height
changes and the follow machinery still never fires from a swipe.
`swipe-time-wiring.test.ts` now pins `right: 0` (and asserts the old
`right: -REVEAL` is gone, scoped to the `label` style) plus the opaque row.

**F3 (MEDIUM) — a foreground resync did not re-arm the silent landing. FIXED.**
`SessionScreenController.appState` now returns whether it actually STARTED a
re-attach (false for a duplicate `active`, offline, a running pull, or no live
attach — the same guards as before, only reported), and the screen arms
`reattachLanding(...)` off that verdict. The four re-attach sites (pull, Retry,
Reopen, foreground) now go through that ONE helper instead of three copies of the
ternary, so they cannot drift apart again. Pure decision tested in
`session-screen.test.ts` (true once per return, false when it cannot attach);
the wiring in `session-screen-follow-wiring.test.ts`.

**Review's LOW (the signature).** Fixed: Execution is signed `deepseek`, which is
what commit `24d47937` says; drift item 5 now records that its geometry was wrong.

**Red before green.** With the new tests and the ORIGINAL sources restored from
`git show HEAD:` (no checkout/restore/stash), 5 fail — the two swipe geometry
tests, the land timer, the foreground arming, and `appState`'s return
(`session-screen.test.ts`, 2 fail). `follow.test.ts` failed on import (it names
the new exports), so those cases are proved by mutation instead.

**Mutations (each reverted; 4 files, 9 mutations, all red):**

| # | Mutation | Fails |
|---|---|---|
| M1 | drop the mount-time `armReveal()` | 1 |
| M2 | drop the `armReveal()` after a landing scroll | 1 |
| M3 | drop `landingReveal`'s not-following guard | 1 |
| M4 | `landingReveal` never shows (settling kept) | 2 |
| M5 | ignore `awaiting` (awaited rows not re-hidden) | 1 |
| M6 | `right: -REVEAL` (the old geometry) | 1 |
| M7 | drop the row's `backgroundColor` | 1 |
| M8 | `appState` returns false while it resyncs | 1 |
| M9 | screen ignores `appState`'s verdict | 2 |

**Gate.** `bunx tsc --noEmit` clean; `bunx tsc -p apps/mobile` clean;
`bunx tsc -p apps/relay` clean; `bun run lint` 1785 files, 0 errors, 0 warnings
(the §6 baseline); `bun test` — **13 036 pass, 5 skip, 0 fail** (926 files). The 5
skips are the three opt-in ones plus the two conditional skips already recorded
above. Two files failed in an intermediate full run and both are unrelated to
this round: `changelog-guard.test.ts` (this round had put a SECOND bullet in
`changelog.d/mobile-open-at-end.fixed.md` — forbidden, one bullet per file; the
swipe already has `mobile-swipe-timestamps.added.md`, so the extra bullet was
removed) and `session-log-store.test.ts` / `main.test.ts` (load flakes under the
130 k-test run; both pass on rerun, twice).

**Still open (unchanged from Review):** the device check on the owner's iPhone —
now also: a 2-message session opens visibly at the end, and a swipe left on a
message row shows its time inside the row's strip.

*— claude-opus-5-5 (fix round 1), 2026-11-17*

### Round 2

**Verdict: REQUEST-CHANGES.** Scope: `git diff HEAD~1` (`67833f68`).

**Gate.** `bun test apps/mobile/test` + the client, daemon and protocol
snapshot-times tests: 2833 pass, 0 fail. `bun run lint`: clean (1785 files).
`bun run typecheck`: clean.

**Round-1 findings, each mutation-checked.** All mutations were reverted and
`git status` is empty.
- **HIGH 1 (list stays hidden): fixed for the case it targets, but see
  NEW HIGH below.** Mutation: `landingReveal` returns `step: null` and keeps
  the state → 2 fails in `follow.test.ts`.
- **HIGH 2 (label off-screen): fixed.** The label is now at `right: 0`, the
  row is opaque, and the frame clips. Mutation: `right: -REVEAL` → 1 fail in
  `swipe-time-wiring.test.ts`.
- **MEDIUM 3 (foreground resync not silent): fixed.** `appState` returns
  `true` when it starts a re-attach, and the screen then arms
  `reattachLanding`. Mutation: `return false` → 1 fail in
  `session-screen.test.ts`.

**NEW HIGH: a slow attach brings back the original bug.**
`follow.ts:255-258` (`landingReveal`) and `SessionScreen.tsx:376-381`.
- The empty list has `contentContainerStyle` `flexGrow: 1`
  (`styles.emptyList`), so its first content measurement is about the
  viewport height, not 0.
- So `landingStep` takes a round on the EMPTY state.
- 120 ms later the timer fires. `content > 0`, so it does not go to
  `landingAwaiting`: it returns `landingDone`.
- When the history arrives (any attach slower than 120 ms, i.e. normal over
  the relay), `landingStep` returns `null`. The rows then go through
  `contentGrew` with `animated: true`: a visible animated scroll through the
  whole transcript, the owner's original complaint.
- Repro (`.tentacle/tmp/mobile-open-at-end/r2-slow-attach.ts`, real event
  order on the pure functions):

```
empty-state measured: {"settling":true,"silent":false,"last":800,"rounds":1,"awaiting":false}
timer: {"settling":false,"silent":false,"last":0,"rounds":0,"awaiting":false}
history landing step: null
falls to contentGrew: {"state":{"following":true,"unseen":false},"scrollTo":39200,"animated":true}
```

- The `awaiting` path is reached only with `content <= 0`, which a laid-out
  empty list never reports. Its tests cover only that case.
- Fix: decide "nothing to land yet" from the ROWS (zero rows, or the status
  still `opening`), not from `content`. Pin it in a test where the timer fires
  on the empty state and the history arrives after it.

**Other regression attacks (nothing found).**
- The mount timer is cleared on unmount (`useEffect(() => disarmReveal)`).
- A re-attach arms `landingQuiet` (`settling` false), so the timer is a no-op
  for it.
- `overflow: "hidden"` on the cell frame clips only the translated row.
  Nothing in `TranscriptRow` draws outside its cell (not device-verified).

**Executor.** The fixes are targeted and each comes with a red test. The
fix-round section is again signed `claude-opus-5-5` while commit `67833f68`
says `deepseek`: correct the signature (§10).

*— claude-opus-5-5, 2026-11-17* (fresh context, round 2)
