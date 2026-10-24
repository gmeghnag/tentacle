# feat/send-now-c — TUI: `Ctrl+X Ctrl+S` sends the queued messages now

> **Status:** implementation (plan approved by the owner 2026-10-23; R0 Ctrl+S pty check approved as the first step)
> **Branch:** `feat/send-now-c` (off `main` **after `feat/send-now-b` is merged**)
> **Type:** feat · **Size:** M · **Blast:** cross-module (the `App.tsx` key handler and turn loop, the `SessionController` contract the cli implements; no protocol, persistence or terminal-IO change) · **Suited:** a weaker model may execute against this plan; standard Review, plus one fresh-context pass on the fallback path (the eval's L/load-bearing rating applied to the whole feature)

Parent decision record: `docs/eval/send-now.md` (D1 join, D2 empty → nothing,
D3 permission/hook → cancel and send, D4 only my rows, D5 only `Ctrl+X Ctrl+S`,
1500 ms chord). Previous slices: a (daemon), b (client). Next: d
(compaction-time queue).

## Context

*— claude-opus-5-5, 2026-10-23*

**Why.** The user-facing half. While a turn runs, the rows the user queued
(steering) can be sent at once with `Ctrl+X Ctrl+S`. That interrupts the turn
(S1) through b's `sendNow`, with a one-time-notice fallback for an old daemon
(S2).

**Premises re-verified on `main` @ `be75584`** (the eval's TUI line numbers
were off by 1; corrected):
- Rows are a bare `queued: string[]` (`tui/src/App.tsx:190`). Enter mid-turn
  pushes optimistically and calls `ctrl.enqueue(text)` (`:703-720`). A reject
  drops ONE row (count-based) and notices "message not queued" (`:714-718`).
  Each `steer` drops the front row (`:484-488`). `run`'s `finally` clears all
  of them and nulls `abortRef` (`:497-499`). Rows render only while `running`
  (`:1167`). `QueuedMessages` takes `readonly string[]`
  (`components/QueuedMessages.tsx:7`).
- `SessionController` (`App.tsx:69-85`) has `send`, `compact?`,
  `enqueue?(text)` and `close?`. The local agent `Session` and the cli's
  `persistingController` both satisfy it.
- Key handling is one `useInput` (`App.tsx:814-…`). Shift+Tab comes first
  (`:817-820`). Then the permission dialog swallows every key (`:823-849`):
  its Ctrl+C does `permission.answer(DISMISSED)` + abort, so no deny goes out
  (`:826-835`). Then Ctrl+C (`:851-861`), paste, panel, Esc (`:897-899`),
  Ctrl+O (`:901`). `rg` finds no `ctrl.*"x"` or `"s"` binding. Ink 5.0.1 maps
  a C0 byte to `(name, ctrl)` (eval, `parse-keypress.js:179-181`,
  `use-input.js:67`). **Ctrl+X and Ctrl+S are free.**
- `/help`'s keys line is `commands.ts:230`.
- `state.ts` already renders a `user_message` event as a user bubble
  (`state.ts:357`, `:389`), and `startContinuation` starts a turn with no
  bubble (`:186`).

**Not verified (R0, the executor's FIRST step, §0):** whether `0x13` (Ctrl+S,
XOFF under `IXON`) reaches the process under **Bun's** `setRawMode`. The
planner wrote the check but was not allowed to run it. Script
(`.tentacle/tmp/send-now-plan/raw.ts` + `run.sh`):
```ts
// raw.ts — does Ctrl+X (0x18) / Ctrl+S (0x13) reach a Bun process in raw mode?
process.stdin.setRawMode(true);
process.stdin.resume();
const seen: number[] = [];
const hex = (x: number): string => `0x${x.toString(16).padStart(2, "0")}`;
process.stdin.on("data", (b: Buffer) => {
  for (const x of b) seen.push(x);
  if (seen.includes(0x71)) {
    console.log(`bytes: ${seen.map(hex).join(" ")}`);
    process.exit(0);
  }
});
setTimeout(() => {
  console.log(`timeout, bytes: ${seen.map(hex).join(" ")}`);
  process.exit(1);
}, 4000);
```
```sh
# run.sh — feed Ctrl+X, Ctrl+S, q through a real pty after raw mode is set
(sleep 1; printf '\030\023q') | script -q /dev/null bun raw.ts
```
Expected: `bytes: 0x18 0x13 0x71`. If `0x13` is missing, **stop and ask the
owner** (D5 names only this chord). Do not pick another key. Also try it
once by hand in a real terminal (macOS Terminal/iTerm), since terminal
emulators can intercept Ctrl+S themselves.

**R0 RESULT (orchestrator, 2026-10-23, tmux 3.8, no tmux config, Bun 1.4.3) — PASS:**
`.tentacle/tmp/send-now-c-r0/raw.ts` in a tmux pane: `ixon before raw: ixon · after setRawMode: -ixon`,
`bytes: 0x18 0x13 0x71` (Bun's `setRawMode` clears IXON, so XOFF never eats Ctrl+S).
`ink.ts` (Ink 5 `useInput`, the TUI's key path), tmux `send-keys C-x`, `C-s`, `C-s`, `q`:
`input="x" (0x78) ctrl=true` · `input="s" (0x73) ctrl=true` ×2 · `input="q"`. So the chord reaches the
TUI handler as `input==="x"/"s"` + `key.ctrl`. Still to try by hand in the owner's terminal emulator
(an emulator may bind Ctrl+S itself). Outside raw mode (plain shell) Ctrl+S is XOFF and freezes output
until Ctrl+Q — not our case while Ink owns the terminal.

**Repro (capability missing)**, 2026-10-23: `rg -n -i 'sendNow|ctrl.*"x"' packages/tui/src` → exit 1.

**Other tasks.** Task 6 (TUI renders foreign turns) will touch `run`/rows.
The row model below (`queued.ts`) is the seam it extends: a row would carry
its origin. Task 5's broadcast would feed the same model with other devices'
rows (read-only, not sent by my send-now: D4).

## Implementation

*— claude-opus-5-5, 2026-10-23*

### Load-bearing assumption

**Each row can be identified by the id it was enqueued with. So the send-now
request can name exactly my rows (D4), and the daemon can tell which of them
were already injected.** Today rows are count-based strings
(`App.tsx:190`, `:715`). b adds `enqueue(text, id?)`. This task gives every
row an id at creation and passes it through. Proof by test: T-C2 asserts the
`sendNow` call's `{id,text}` equals the ids `enqueue` was called with.

### Preconditions

- b's `sendNow(messages, target, signal)` resolves on the ack with the
  successor's events. It rejects with the RPC error, and the successor
  rejects `Cancelled` if it was cancelled before it started.
- `abortRef` semantics: abort of the turn's controller → `session/cancel`
  (`remote-session.ts:180-184`). The daemon's `cancel` also cancels a
  reserved successor (a).
- "Logic lives in pure modules" (§7): chord timing, row bookkeeping and the
  send-now decision go into pure files, tested without Ink.

### Design

- **`tui/src/chord.ts` (new, pure):**
  `stepChord(state, char, key, now) → { state, action: "sendNow" | "consumed" | "pass" }`.
  Ctrl+X arms and is `consumed`. Ctrl+S within 1500 ms of arming →
  `sendNow`. Any other key, or the window expired, disarms, and **that key is
  `pass`ed** to the rest of the handler unchanged. Ctrl+S while not armed →
  `pass`. Called in `useInput` right after Shift+Tab, **before** the
  permission branch, so the chord works while the dialog is up (D3a).
- **`tui/src/queued.ts` (new, pure):** rows `{id, text, state: "queued" | "sending"}`
  with these operations:
  - `add(text, id)`;
  - `onSteer()`: drop the front `queued` row (today's FIFO, `:487`);
  - `onReject(id)`: drop that row (exact, no longer "one from the end");
  - `takeForSendNow()`: mark every `queued` row `sending`, return their
    `{id,text}`;
  - `onTurnEnd()`: drop `queued` and `sending`, the old turn is over (today's
    `:499`);
  - `restore()`: drop `sending` rows and return their texts joined (D1), to
    put back in the input field.

  Rows stay **visible** while `sending`, so the spinner row (S3) is the
  feedback during a slow cancel.
- **`tui/src/send-now.ts` (new, pure):**
  - `planSendNow({rows, running, pending, canSendNow, latchedUnsupported})`
    returns `none` when no `queued` rows exist (D2), no turn is running, or a
    send-now is already pending. It returns `atomic(messages)` when the
    controller has `sendNow` and it is not latched, and `fallback(text)`
    otherwise.
  - `onSendNowError(code)` maps `MethodNotFound` → `fallback` (latch + one
    notice), `NoTurnRunning` → `silent` (all already injected; rows clear on
    the turn end), `Cancelled` and anything else → `restore`.
- **`SessionController`** (`App.tsx:69-85`) gains
  `sendNow?(messages, target, signal): Promise<AsyncIterable<SessionEvent>>`
  and `enqueue?(text, id?)`. Both are optional: the local agent `Session` has
  no `sendNow` and so always takes the fallback.
- **`App.tsx`:**
  - Enter mid-turn: `id = crypto.randomUUID()`, `rows.add(text, id)`,
    `ctrl.enqueue(text, id)`. A reject → `rows.onReject(id)` + today's notice.
  - `steer` → `rows.onSteer()`. `run`'s `finally` → `rows.onTurnEnd()`, and
    it nulls `abortRef` **only if it still holds this run's controller** (the
    successor installs its own).
  - **`sendNow()` (`atomic`):** `messages = rows.takeForSendNow()`. Create
    `next = new AbortController()` and set `abortRef.current = next` at once,
    so Esc/Ctrl+C in the window cancels via `next`. The old controller is
    already aborted daemon-side, and a second `abort()` on it would send
    nothing. Call `ctrl.sendNow(messages, "turn", next.signal)`.
    - On resolve: store the iterable in `successorRef`. When the old `run`'s
      `finally` runs (or at once if it already ran), start
      `runStream(iterable, next)`, i.e. `run`'s loop factored to take an
      iterable. It starts with `startContinuation` (no local bubble), and the
      bubble comes from b's `user_message` (the daemon's authoritative,
      filtered prompt). So `run(text)` becomes `runStream(ctrl.send(…), …)`
      plus `startTurn`: one loop, not two.
    - On reject → `onSendNowError`: `restore` puts `rows.restore()`'s text in
      the input field (appended to any draft with `"\n\n"`) plus a notice
      "_send-now failed: …_". `silent` does nothing. `fallback` is below.
    - The successor iterable rejects `Cancelled` (Esc in the window) → the
      same `restore`.
  - **Fallback (old daemon, or a controller without `sendNow`):** a
    once-per-session notice "_this daemon can't send-now atomically —
    stopping the turn, then sending_" (latched, no repeat). Then
    `text = join(rows sending)`, `fallbackRef = text`, and
    `abortRef.current.abort()` (today's Esc). In `run`'s `finally`:
    `fallbackRef` set → `run(text)`. If that prompt fails with
    `TurnInProgress` (another client's prompt won the non-atomic gap), put
    the text in the input field plus a notice. It is never dropped.
  - **Permission dialog up + chord with rows:** `permission.answer(DISMISSED)`
    (as Ctrl+C, `:833`, so no deny goes out), then `sendNow()`. The daemon's
    abort settles the ask `cancelled` (a, T-A6). With no rows the chord does
    nothing and the dialog stays (D2).
  - `/help` keys line (`commands.ts:230`): add `· Ctrl+X Ctrl+S send queued now`.

### Files

1. `packages/tui/src/chord.ts` (new).
2. `packages/tui/src/queued.ts` (new).
3. `packages/tui/src/send-now.ts` (new).
4. `packages/tui/src/App.tsx`: `SessionController`, row model, chord dispatch, `sendNow`, `runStream`, fallback, `abortRef` ownership.
5. `packages/tui/src/commands.ts`: the `/help` keys line.

### Failure modes

| Case | Convergence |
|---|---|
| Empty queue (D2) | `planSendNow` → `none`: no request, no cancel, no notice. T-C3. |
| Chord split by another key | The other key disarms and passes through, so it behaves as if the chord never started. T-C1. |
| Ctrl+X alone | Consumed, no visible effect, expires after 1500 ms. (Ctrl+X was unbound, so no regression.) |
| Old daemon | One notice, then abort, then send the joined text after the turn ends. If another prompt wins, the text goes back to the input field. T-C5. |
| Esc/Ctrl+C in the window | `abortRef` is the successor's, so `session/cancel` → successor cancelled → rows' texts back in the input field. T-C6. |
| Texts typed after the chord | Enqueued to the old turn (b keeps the binding), re-seeded by the daemon into the successor (a). Shown as `queued` rows. The `steer` of the successor drops them as usual. |
| `NoTurnRunning` (all injected just before) | Silent. The rows clear on the old turn end, and their `steer` echoes are already in the transcript. |
| Second chord while one is pending | `none` (pending guard). |
| A row rejected after `takeForSendNow` | `onReject(id)` drops it. The daemon got it in `messages` anyway (it never accepted the enqueue, so it is in the prompt). Nothing lost. |
| Quit (`exitPendingRef`) during the window | `run`'s `finally` exits before starting the successor stream (today's order, `:501-504`). The daemon runs the successor unobserved, as any turn after a quit does today. |

### Tests

Red first, then the narrowest file.
- `tui/test/chord.test.ts`: arm/fire; fire at 1499 ms vs 1501 ms; another key
  passes through and disarms; Ctrl+S unarmed passes.
- `tui/test/queued.test.ts`: FIFO steer, reject by id (the middle row),
  take/mark `sending`, `onTurnEnd`, `restore` joins with `"\n\n"`.
- `tui/test/send-now.test.ts`: the `planSendNow` table; `onSendNowError` per
  code.
- `tui/test/queue.test.tsx` (the existing ink-testing-library + fake
  controller pattern):
  - **T-C2** rows A, B queued → chord → `sendNow` called once with
    `[{id:idA,"A"},{id:idB,"B"}]`, the same ids `enqueue` got. Red on `main`
    (no chord). Mutation: generate a fresh id in `takeForSendNow` → red.
  - **T-C3** empty rows → chord → no `sendNow`, no abort, no notice (D2).
  - T-C4 dialog up + rows → chord → `answer(DISMISSED)`, then `sendNow`.
  - **T-C5** controller rejects `MethodNotFound` → one notice, abort, then
    `send("A\n\nB")` after the old turn ends. A second chord in a later turn
    goes straight to the fallback with no second notice.
  - T-C6 the successor iterable rejects `Cancelled` → the input field holds
    `"A\n\nB"`.
  - T-C7 the successor streams → a user bubble `"A\n\nB"` (from
    `user_message`) and no duplicate bubble.
- Gate: `bun run check`, lint baseline clean.

## Execution

*— claude-opus-5-5, 2026-10-23*

**Baseline** (unchanged tree, `feat/send-now-c` @ 24c13c6 + the untracked plan),
`bun run check`: typecheck clean · lint `Checked 411 files … No fixes applied` ·
**2079 pass, 2 skip, 0 fail** (2081 tests, 171 files). As expected. Log:
`.tentacle/tmp/send-now-c/baseline.log`.

**Repro (capability missing):** `rg -n -i 'sendNow|ctrl.*"x"' packages/tui/src`
→ no match (rg exit 1). R0 was not redone (orchestrator's PASS above).

**Premises re-verified on today's code** (all still hold; line numbers moved):
- Rows were a bare `string[]` (`App.tsx:190`), `enqueue(text)` with a
  count-based reject (`:714-718`), FIFO `steer` drop (`:486-488`), `finally`
  clears them and nulls `abortRef` (`:497-499`), rows render only while
  `running` (`:1167`). The `useInput` order (Shift+Tab `:817`, permission
  `:823-850`, Ctrl+C `:851`, Esc `:897`) and `/help` (`commands.ts:230`) as cited.
- 4b's client: `RemoteSession.sendNow(messages, target, signal)`
  (`client/src/remote-session.ts:182`) refuses LOCALLY with `NoTurnRunning`
  when the session has no id yet (first `send` still opening) or its active
  turn already ended client-side (`:195`); `TurnInProgress` if a send-now is
  already waiting (`:198`); an unstarted successor rejects `Cancelled`, decided
  by `delivered` (`finish`, `:570-583`) — the TUI never second-guesses it, it
  only reacts to `Cancelled`. Enqueues bind to the old turn until the hand-off
  (`promote`, `:280`). A send-now's `turn_start` with prompt `""` (a
  continuation) yields NO `user_message` (`:508`).
- Daemon (`daemon/src/hosted-session.ts:850-975`): a `send_now` whose target
  already ended still starts a turn with the undelivered texts, a continuation,
  or answers `NoTurnRunning` when everything was delivered and nothing awaits an
  answer.
- cli: `PersistingController` already has `enqueue(text, id?)` and `sendNow`
  (`cli/src/local-runtime.ts:91-95`); `createSession` returns it typed as
  `SessionController`. `connect.ts:125` returns a bare `RemoteSession`. The
  in-process `inProcessSessions` controller (`cli/src/session-jobs.ts:120-131`)
  has no `sendNow`.

**As built, in plan order:**
1. `tui/src/chord.ts` (new, 40 lines): `stepChord(state, char, key, now)` →
   `sendNow | consumed | pass`; `CHORD_WINDOW_MS = 1500` (inclusive: `<=`);
   letters matched case-insensitively (Ctrl+Shift+S).
2. `tui/src/queued.ts` (new): rows `{id, text, state}` + `addRow`, `onSteer`,
   `onReject(rows, id, owned)`, `takeForSendNow`, `onTurnEnd`, `handOff`,
   `restoreSending`, `takeAll`, `rowTexts`.
3. `tui/src/send-now.ts` (new): `planSendNow`, `onSendNowError`,
   `afterOldTurn`, `withRestored`, `fallbackNotice`, `errorCode`, and
   `SendNowErrorCode` (a copy of the 4 protocol codes — the TUI does not depend
   on `@tentacle/protocol`; `send-now.test.ts` pins the copy to
   `protocol/src/jsonrpc.ts` by relative path).
4. `tui/src/App.tsx`:
   - `SessionController` (`:108`, `:117`): `enqueue?(text, id?)` and
     `sendNow?(messages, target: "turn" | "compaction", signal?)`. This is the
     "widening": `createSession` keeps its `SessionController` type and the
     cli's `PersistingController`/`RemoteSession` now satisfy the optional
     member structurally (typecheck green, no cli edit).
   - Rows: `rowsRef` (truth, read synchronously by the chord) + state for
     rendering, `setRows` (`:246`); `QueuedMessages` gets `rowTexts(queued)`
     (`:1506`). Enter mid-turn: `id = crypto.randomUUID()`, `addRow`,
     `enqueue(text, id)`; a reject → `onReject` (`:1038`).
   - `run` is split: `streamTurn(open, controller, opts)` (`:608`) is the one
     event loop; `run` (`:703`) = `startTurn`/`startContinuation` +
     `streamTurn(() => session.send(…))`. A send-now's new turn goes through the
     same `streamTurn` (`successor: true`), started with `startContinuation`;
     its bubble is b's `user_message`.
   - `streamCtrlRef`: the streamed turn's controller. `finally` nulls
     `abortRef` only if it still holds this turn's controller.
   - `settleSendNow` (`:570`), `sendNow` (`:750`), `restoreInput` (`:532`,
     appends to the draft with `"\n\n"` via a new `LineEditor.update(f)` —
     functional, so no stale draft), `showIdle` (`:543`), `noticeFallback`
     (`:735`).
   - Chord dispatch right after Shift+Tab, before the permission branch
     (`:1151`); with the dialog up and rows, `permission.answer(DISMISSED)`
     then the send-now; with no rows, `none` and the dialog stays.
5. `tui/src/commands.ts:230`: `· Ctrl+X Ctrl+S send queued now`.
6. `tui/src/hooks.ts:104,138` (not in the plan's file list): `update(f)`.

**Drift from the plan (and why) — every nuance the owner should know:**
1. **`NoTurnRunning` is NOT silent** (carry-over 10; plan said `silent`).
   `onSendNowError` maps it to `deferred`: the rows stay up (`sending`); when
   the old turn ends, the rows its `steer` echoes did not drop are sent as a
   NEW prompt (`run`, a normal user bubble). Why a plain prompt: a local
   refusal means the daemon was never asked, and `RemoteSession.sendNow`
   refuses any `"turn"` send-now with no live client-side turn, so the TUI
   cannot hand it to the daemon's id-filter without changing 4b's client (out
   of scope). The TUI cannot tell a local from a daemon `NoTurnRunning` (same
   code, same message). For the daemon's one this is still right: it answers
   only when every id was injected, and those `steer` echoes precede the old
   `turn_end` on the stream, so nothing is left to send. **Approximation:** if a
   resync (`history_reset`) happened after the chord, an echo may have been
   behind the cut → the texts go back to the input field with a notice instead
   of being sent (`afterOldTurn` → `restore`): a visible choice, never a silent
   duplicate, never a loss. Same rule for the fallback. **Approximation 2:** in
   the "session still opening" case (`!id`, the very first turn) nothing is
   interrupted — the texts are sent right after that first turn. **Not
   covered:** the daemon-restart `[system?, user]` case (addendum 5) answers the
   daemon's `NoTurnRunning`; the TUI then sends only rows still unechoed when
   the old turn ends. I expect a restart to reach the TUI as a resync (so the
   restore rule applies, not a resend), but this is **unverified** — no test
   drives a daemon restart through the TUI; verify with a reattach test.
2. **`onSteer` drops the front row whatever its state** (plan: the front
   `queued` one). Rows are in enqueue order and the daemon injects in that
   order; after a chord the front rows are `sending`, and an echo of one of them
   (injected just before the cancel; the daemon leaves it out of the prompt)
   must drop it, not a later `queued` row (mutation M11 proves it matters).
3. **`onReject(rows, id, owned)`** (plan: `onReject(id)` drops it). A row a
   send-now took keeps its text with the send-now (sent or restored), so a late
   enqueue refusal of it is silent; `owned` = every id ever taken (an
   App-lifetime `Set`, cleared never — small). Otherwise unchanged from today:
   the row goes and "message not queued" is shown, **also when the row is
   already gone** (today's behaviour, which 4b's kept `turnId` relies on).
4. **Restore has two shapes.** A refused request while the old turn still runs
   → `restoreSending` (rows typed after the chord stay: they are still that
   turn's steers). A successor `Cancelled`, or a refusal after the old turn
   ended → `takeAll` (the daemon's contract: an unstarted successor delivered
   neither its prompt nor the steers typed for it).
5. **Hand-off timing.** The `sending` rows stay visible until the new turn's
   first non-`unsupported` event; then `handOff` drops them and keeps the rows
   typed after the chord (they become the new turn's steers; its `steer` echoes
   drop them). Between the old turn's end and the ack the TUI keeps showing a
   running turn (`startContinuation`), so Enter keeps queueing (b binds it to
   the promoted successor) instead of starting a racing prompt.
6. **Fallback notice wording**: "_this daemon can't send-now atomically …_"
   after `MethodNotFound`, "_this session can't …_" for a controller with no
   `sendNow` (the in-process session has no daemon). One notice per App
   lifetime (not reset by `/clear`), shared by both.
7. **Fallback aborts the streamed turn's controller** (`streamCtrlRef`), not
   `abortRef`; after `MethodNotFound`, `abortRef` is moved back from the
   unused `next` to the old turn's controller first.
8. **Fallback `TurnInProgress`**: the follow-up prompt already showed its bubble
   (`startTurn`); the turn fails (⚠ line) AND the text goes back to the input
   with a notice.
9. **Wake.** A chained turn (successor / fallback / deferred send) clears
   `wakePendingRef`: it flushes the job exits at its own start, so no extra
   continuation turn follows it.
10. **Continuation successor** (prompt `""`): no bubble (b sends no
    `user_message`); the texts are already in the transcript as their `steer`
    bubbles; the turn renders like an auto-wake continuation. Nothing to add.
11. **Compaction target / enqueue during compaction (carry-over):** not
    reachable from c — the TUI only sends `"turn"`; rows exist only while a
    turn runs, and `/compact` is refused while one does. Left to 4d.
12. **Tests in a new file** `tui/test/send-now-app.test.tsx` instead of
    `queue.test.tsx` (the known flake file); same ink-testing-library pattern.
13. **Size**: the `App.tsx` diff is +~390 lines (`git diff --stat`: 3 files,
    +410 −54), more than an "M" suggests; most is the moved loop + comments.
14. **Not changed, known (D4/task 5):** steer echoes are still matched by
    count, so another client's steer would drop one of my rows (pre-existing).

**Tests (+44: 2079 → 2123).**
- `chord.test.ts` (7): arm/fire, 1499 vs 1501 ms, case-insensitive, another
  key passes and disarms, unarmed Ctrl+S passes, re-arm.
- `queued.test.ts` (10), `send-now.test.ts` (13): the pure tables.
- `send-now-app.test.tsx` (14), a fake controller (held turns, scripted
  `sendNow`): T-C2, T-C3, T-C4, T-C4b (dialog stays with no rows), T-C5 (the
  notice counted on the whole transcript via `/save`), T-C5b (no `sendNow`),
  T-C6, T-C6b (Esc in the window aborts `next`, not the old signal), T-C7,
  T-C7b (rows up until the new turn starts; a row typed after the chord
  survives the hand-off), T-C8 (`NoTurnRunning` → sent after the old turn,
  minus the echoed row), T-C9 (+resync → restored, unsent), T-C10
  (`TurnInProgress` → restored, turn keeps running), T-C11 (late enqueue
  refusal of a taken row is silent).

**Red → green.** Pure files: red on missing modules (a feat), property reds
from the mutations. App tests against `git show HEAD:…/App.tsx`: **12 fail,
2 pass** (T-C3/T-C4b are D2 guards, green on both — their non-vacuity is M2).
Output: `.tentacle/tmp/send-now-c/red-app.txt`, `red-app-final.txt`.

**Mutations** (Edit → narrow tests → `cp` from `bak/`):

| # | Mutation | Red |
|---|---|---|
| M1 | fresh id in `takeForSendNow` (plan's) | T-C2 + 2 pure |
| M2 | no D2 guard | T-C3, T-C4b, pure |
| M3 | no `DISMISSED` | T-C4 |
| M4 | chord after the permission branch | T-C4 |
| M5 | no `MethodNotFound` latch | T-C5 |
| M6 | fallback notice repeats | T-C5 (**survived** the first T-C5, which counted on screen; strengthened with `/save`) |
| M7 | `abortRef` not moved to `next` | T-C6b |
| M8 | `NoTurnRunning` silent (plan's original) | T-C8, T-C9 |
| M9 | resync ignored | T-C9 + pure |
| M10 | no hand-off | T-C7b (**survived** T-C7 alone, so T-C7b was added) |
| M11 | steer drops the front `queued` only (plan's original) | T-C8 + pure |
| M12 | successor `Cancelled` → plain failure | T-C6 |
| M13 / M13b | `owned` ignored (pure / App passes `new Set()`) | pure / T-C11 |
| M14 | window ×2 | chord window test |

Afterwards **byte-identical**: `cmp` of the 4 mutated src files vs `bak/`;
`git status --short` diffed with the pre-mutation snapshot (empty); `shasum`
of `packages/tui/src/*` diffed with the snapshot (empty).

**Gate** (`bun run check`): typecheck clean · lint `Checked 418 files … No
fixes applied` · **2123 pass, 2 skip, 0 fail** (2125 tests, 175 files). Two
earlier lint/tsc trips were fixed by hand (`PermissionRequest.input` in the
test; Biome format). Stability: `--rerun-each 5` of `send-now-app.test.tsx` +
`queue.test.tsx` → 85/85. Two outliers during the run (one T-C5 at 152 s and
one T-C4 at 25 s, both failing on time) coincided with the host sleeping
overnight; alone and in the reruns they pass in ~0.3–1 s. Logged, not a flake
I could reproduce.

**Open items.**
- *For 4d:* the `"compaction"` target and the enqueue-during-compaction window
  (item 11); `SessionController.sendNow` already accepts the target.
- *For the owner:* (1) the deferred `NoTurnRunning` sends a plain prompt — a
  daemon-decided resend would need 4b's client to forward a stale `"turn"`
  target instead of refusing locally (small client change; the daemon already
  handles it); (2) the resync → restore approximation; (3) R0 by hand in your
  terminal emulator (some bind Ctrl+S); (4) the one-notice latch is per App,
  not per session.
- Throwaway: `.tentacle/tmp/send-now-c/` (baseline/gate logs, red outputs,
  `bak/`, an unused `mutate.ts` runner — its `bun` run needed approval, so the
  mutations were applied by hand).

### Execution — follow-up 1 (no client-side guessing)

*— claude-opus-5-5, 2026-10-24*

**Why.** Overnight, the orchestrator applied the owner's standing principle,
recorded in the `docs/eval/send-now.md` addendum and decided twice in task 4:
**the client never guesses what the daemon knows.** The owner confirms it in
the morning. Two of my approximations broke it:
- the TUI re-sent the texts as a plain prompt after a `NoTurnRunning`;
- after a resync, it restored the texts into the input instead.

The daemon already decides that case, so both guesses are removed (drift items
1 and "for the owner" (1)–(2) above are superseded).

**Premise verified first (no protocol change).**
`daemon/src/hosted-session.ts:850-866` handles a `"turn"` target that already
ended as follows:
- `running` is false, so `assertIdle` runs;
- if the caller's ids are not delivered, it starts a turn with them;
- if they are delivered but unanswered, it starts a continuation;
- only when there is nothing to answer does it reply `NoTurnRunning`.

So the client's existing `interrupt` shape, `{kind:"turn", turnId: <last-known
turn>}`, is exactly what the contract defines (`protocol/src/session.ts:334-356`,
"a stale request never cancels some OTHER turn"). The client builds it from
`this.turnId`, which it keeps after a turn ends on purpose
(`remote-session.ts:68-75`).

**4b client change** (`client/src/remote-session.ts`, `sendNow` at `:189`):
- `:207`: the local refusal `!current` is gone. With no live turn on the client,
  the request still goes out and names the last turn. The new turn is
  `install`ed at once: there is nothing to promote it from. This is the same
  path 4b uses for the compaction target.
- `:202`: while the first `send` is still opening the session, `sendNow` waits
  for the open. That `send` awaited the open first, so its turn is installed
  and its `prompt` is written before the `send_now`. The daemon then sees a
  running target and interrupts it atomically. `closed` is re-checked after
  the wait.
- A local `NoTurnRunning` remains only when no turn was ever sent (no
  daemon-side session or turn exists). That is a fact, not a guess.
- The doc comment states the rule.

**TUI change.**
- `send-now.ts`: `onSendNowError` maps `NoTurnRunning` to `delivered`. That is
  the daemon's fact: it already has every text and nothing awaits an answer.
  New constant `NOTHING_TO_SEND`.
- `App.tsx:828` (the `delivered` branch):
  - nothing is sent and nothing is restored;
  - the notice "_send-now: nothing to send — the daemon already has your
    queued messages_" is shown;
  - if the old turn is still streaming, its `steer` echoes and its end clear
    the rows as usual;
  - if it already ended on screen, the rows go now, the TUI shows idle and a
    pending wake fires (`wakeIfPending`, `:562`, now shared with the stream's
    `finally`).
- The `deferred` mode is removed: no more "re-send as a prompt at the old
  turn's end".
- `restore` happens only on a `Cancelled` successor (decided by the daemon's
  `delivered: false`, read by the client) or on a refusal that delivered
  nothing. Both were unchanged.

**Fallback kept ONLY for an older daemon** (documented in `send-now.ts`
`afterOldTurn` and `App.tsx` `PendingSendNow`):
- It applies on `MethodNotFound`, or when the controller has no `sendNow` (the
  in-process session).
- The turn is stopped, then the rows its echoes did not drop are sent as a
  prompt.
- After a resync, they are restored into the input instead.
- Such a daemon has no `send_now`, so it has no facts to ask for. This is the
  only place left that infers, and its notice now says "(older daemon)".
- When `delivered` is absent (an older daemon with `send_now`), the 4b client
  keeps its documented restore-over-loss.

**Restart case (item 3) — verified, R1** (`client/test/reattach.test.ts:533`,
a real `SessionHost` restart through the reattach harness):
1. Turn T1 runs and "A" is enqueued (id `a`), so it is on disk in `enqueueIds`.
2. The daemon restarts from a record that is idle with history `[user "A"]` and
   T1 ended. This is the addendum-5 shape: "A" drained with no reply.
3. The client reconnects. T1's re-sent prompt gets the cached end.
4. `sendNow([a])`: the daemon (one real call) answers `NoTurnRunning`. No turn
   starts, the model is not called, and the history is unchanged (`["A"]`).
5. `sendNow([z])` with a text that was never delivered: the daemon starts a
   turn with "Z", whose bubble is "Z".

What the TUI shows for that `NoTurnRunning`: T-C8/T-C9. The notice says
"nothing to send"; no prompt is sent, nothing goes into the input, and the rows
go. "A" stays unanswered in the history until the next prompt (addendum item 5,
by design: an unrequested turn could run tools).

**Fallback notice per session (item 4): done, cheaply.** `/clear` is the only
place a new session is made (`App.tsx:917`), and it resets both latches:
- the notice;
- `MethodNotFound`: a new session asks the daemon again.

**Tests (+6; T-C8/T-C9 rewritten):**
- client CF-1: the turn already ended on the client, so the request reaches
  the daemon with `interrupt` = the last turn and the successor streams;
- CF-2: the daemon's `NoTurnRunning` rejects, one request is sent, and
  steering still names the last turn;
- CF-3: during the session open, the request order is open → prompt →
  send_now and the opening turn is interrupted;
- R1 (above);
- TUI T-C8: the daemon's `NoTurnRunning` while the old turn streams sends
  nothing, restores nothing, shows the notice and the rows go;
- T-C9: the same, after the old turn already ended on screen, also leaves the
  TUI idle;
- T-C5c: the notice appears again after `/clear`;
- T-C5d: `/clear` asks the daemon again.

**Red first** (every behaviour change, on the pre-change code):
- CF-1, CF-2, CF-3 and R1 were red. On R1 the property itself failed: `daemon
  calls: expected 1, received 0`.
- T-C8 was red (no "nothing to send" notice).
- T-C9 was red: the old guess re-sent "alpha" as a prompt; the frame showed
  `› alpha · reply to alpha`.
- T-C5c was red (0 notices after `/clear`).
- T-C5d was written after the change. Its red is mutation N5b.

**Mutations** (Edit, then the narrow tests, then `cp` from `bak2/`):

| # | Mutation | Red |
|---|---|---|
| N1 | the client's local `!current` refusal back | CF-1, CF-2, R1 |
| N2 | no wait for the opening session | CF-3 |
| N3 | TUI `NoTurnRunning` → restore | T-C8, T-C9 + pure |
| N4 | `delivered` branch without `showIdle` | T-C9 |
| N5 | `/clear` keeps the notice latch | T-C5c |
| N5b | `/clear` keeps the `MethodNotFound` latch | T-C5d |

Afterwards the tree was **byte-identical**:
- `cmp` of the 3 mutated src files against `bak2/`;
- `git status --short` diffed with `status-before2.txt`: empty;
- `shasum` of `client/src/*` and `tui/src/*` diffed with `sha-before2.txt`:
  empty.

**Gate** (`bun run check`):
- typecheck clean;
- lint `Checked 418 files … No fixes applied`; one hand fix along the way, an
  import order;
- **2129 pass, 2 skip, 0 fail** (2131 tests, 175 files): +6 against the
  2123/2/0 baseline, with the same opt-in skips.

No time-outs this run. `--rerun-each 3` of `send-now-app.test.tsx` and
`client/test/send-now.test.ts`: 111/111.

**Still open.**
- 4d: the compaction target, as before.
- Owner: R0 by hand in your emulator.
- Owner: the older-daemon fallback still infers, as it must. That inference is
  documented, and it is the only one left.

### Execution — follow-up 2 (Review findings)

*— claude-opus-5-5, 2026-10-24*

This follow-up fixes the fresh-context Review's findings 1–5 (verdict
REQUEST-CHANGES). The Review section itself is untouched.

**Gate baseline:** 2129 pass / 2 skip / 0 fail, lint clean (the end of
follow-up 1).

**Finding 1 — what happens to the caller's texts on `TurnInProgress`, now
reported by the daemon.**

*Premises verified first:*
- The daemon handles requests in arrival order, synchronously up to
  `hosted.enqueue`: `transport/src/peer.ts:332-352` (`handleRequest`, no `await`
  before the handler) and `daemon/src/connection.ts:151-176`. So on one link
  every `enqueue` the TUI sent before the chord is decided (accepted or
  refused) before the `send_now` is handled. That makes the daemon's answer
  final for those ids.
- `transport/src/peer.ts:359`/`:442` already carries `error.data` both ways.

*Throw sites reachable from `session/send_now`* (`daemon/src/hosted-session.ts`):
the reserved send-now check (`:843`) and `assertIdle` after an ended target
(`:866`, which throws `TurnInProgress` or `CompactInProgress`). There is no
other one; `known`/`successor` retries return before both. Each case below is a
daemon test that checks both the report and the actual fate:

| Test | Site | State | Caller's id | Fate (asserted) | Reported `held` |
|---|---|---|---|---|---|
| F-1 | `:843` | another client's send-now waits on MY running turn | `a` queued in my turn | carried into its successor, in history once | `a` |
| | | | `b` never enqueued | never reaches the daemon | — |
| F-2 | `:843` | my turn ended; a send-now waits on another turn | `a` drained by my turn | in history once | `a` |
| F-3 | `assertIdle` | my turn ended; another client's turn runs | `a` drained | in history | `a` |
| F-4 | `assertIdle` | my turn cancelled with `a` pending, then another client's **prompt** runs | `a` | dropped (`prompt` resets the queue, `:803`) | — |
| F-5 | `assertIdle` (`CompactInProgress`) | my turn ended, a compaction runs | `a` drained | in history | `a` |
| F-6 | `assertIdle` (`CompactInProgress`) | my turn cancelled with `a` pending, compaction runs, no successor | `a` | dropped by the next prompt | — |

**Decision: option (b), a small additive field.** There is no existing
truthful result or error that says "these are held", so (a) was not possible.
- A refusal now carries
  `error.data = { held: string[] }` (`SendNowRefusalSchema`,
  `protocol/src/session.ts:393`; the contract comment at `:356`).
- The daemon builds it in `refusal` (`hosted-session.ts:902`). An id is held
  when it is delivered (`isDelivered`) or in the steering queue while a turn
  that will drain it exists. Such a turn is either the running one (not a
  compaction) or the reserved send-now, which carries the queue over.
- **Protocol impact:**
  - a strip schema, exported, so `schema/protocol.json` was regenerated with
    `bun run schema:export` (+13 lines, additive; the drift test is green);
  - no `PROTOCOL_VERSION` bump and no record change;
  - no addendum decision changes;
  - an older client ignores `data`; an older daemon sends none, and the TUI
    then restores every sent text (the documented fallback, T-C10b).

**TUI:**
- `planRefusal` (`send-now.ts:104`), built on `heldIds` (`:74`) and
  `afterRefusal` (`queued.ts:90`):
  - held rows become `queued` again while the old turn streams; their echo or
    the turn's end clears them;
  - only unheld `sending` texts go back to the input;
  - rows typed after the chord stay the old turn's.
- When everything is held, the notice is "_… the daemon holds your queued
  messages_" and the input is not touched.
- `App.tsx:815` only runs the step.

**Drift / behaviour changes the owner should know:**
1. **A refusal after the old turn is already over no longer restores rows typed
   after the chord.** It used to (`takeAll`). Those enqueues have their own
   daemon answer: if accepted, the daemon holds them, with the fate of any
   queued text; if refused, the "not queued" notice is shown and the row is
   dropped. So restoring them was itself a guess.
2. **"Held" means "has the fate of any queued text".** Such a text is lost if
   that turn is then cancelled without a successor. Today that is true of every
   queued row: Esc drops them. One related 4a gap is **not fixed here (owner
   question)**:
   - Another client's send-now carries my undrained steers (F-1).
   - If that successor is cancelled before it starts (`endUnstarted`), its
     `delivered: false` tells only ITS client to restore its own texts.
   - My carried steers stay in the queue until the next `prompt` drops them,
     and nothing tells my client.
   - Fixing it needs a daemon notice, or re-seeding the queue for the next
     turn. That is a change to the 4a contract, so it was not implemented.
3. **Finding 4: the atomic chord no longer dismisses the dialog.**
   - An accepted send-now aborts the turn daemon-side. That withdraws the ask
     (T-A6; the router aborts the request, the dialog closes, nothing is sent).
   - A refused one leaves the turn and its dialog answerable, so there is no
     orphaned ask.
   - The fallback still dismisses, like Ctrl+C, because it always stops the
     turn itself.
   - This differs from the plan's D3 text ("`answer(DISMISSED)`, then
     `sendNow()`"). The effect D3 asks for, cancel and send with no deny,
     holds.
   - UX nuance: the dialog stays on screen until the withdrawal arrives, one
     round trip. A key pressed in that window answers the ask, and the daemon
     ignores a late answer.
4. **`restoreSending` was removed.** `afterRefusal(rows, null, true)` is its
   exact replacement.

**Findings 2–5:**
- **F2 (M-R2):** T-C10 (rewritten: `held`, plus a row typed after the chord)
  and T-C10b kill "treat the old turn as over".
- **F3 (M-R1):** client CF-4 (`client/test/send-now.test.ts:448`): `close()`
  during the first open makes `sendNow` reject `UnknownSession` with nothing
  sent. CF-5 (`:463`) pins that `data` reaches the caller untouched.
- **F4:** T-C4 (rewritten: the fake daemon withdraws the ask on accept) and
  T-C4c (refused: the dialog stays, and `y` answers it).
- **F5:** moved into the pure modules:
  - the restore shape and the refusal step (`planRefusal`/`afterRefusal`);
  - `Cancelled` handling (`onSuccessorError`, `send-now.ts:127`; App `:662`).

  **Debt left in `App.tsx`** (small dispatches, Ink-tested only):
  - `settleSendNow`'s atomic-vs-fallback split;
  - the fallback `TurnInProgress` → restore branch in `streamTurn`'s `catch`
    (older daemon only);
  - the `!old` → `showIdle` + `wakeIfPending` side effects.

**Red → green:**
- F-1…F-5 were red on `data: undefined`, with code and scenario as expected.
  F-6 was added for P2 (it was written green, and P2 is its red).
- T-C10 and T-C4c were red on the old behaviour:
  `.tentacle/tmp/send-now-c/red-fu2.txt`.
- CF-4, CF-5, T-C10b and the updated T-C4 were green on both versions: they pin
  existing behaviour, and their reds are M-R1, P5 and P6.

**Mutations** (Edit → narrow tests → `cp` from `bak3/`/`bak4/`; all red):

| # | Mutation | Red |
|---|---|---|
| M-R1 | no `closed` re-check after the open | CF-4 |
| M-R2 | TUI treats the old turn as over (`oldRunning=false`) | T-C10, T-C10b |
| P1 | daemon sends no `data` | F-1…F-6 |
| P2 | queue counted with no live turn | F-6 |
| P3 | delivered ids not held | F-2, F-3, F-5 |
| P4 | queued ids not held | F-1 |
| P5 | TUI ignores `held` | T-C10 + pure |
| P6 | atomic chord dismisses the dialog again | T-C4c |
| P7 | `Cancelled` successor → plain failure | T-C6 + pure |

After the mutations the tree was **byte-identical**:
- `cmp` of the 4 mutated src files against `bak4/`;
- `git status --short` diffed with `status-before4.txt`: empty;
- `shasum` of `daemon/src`, `client/src` and `tui/src` diffed with
  `sha-before4.txt`: empty.

**Gate** (`bun run check`):
- typecheck clean;
- lint `Checked 418 files … No fixes applied`; along the way, an import order
  and two format nits were fixed by hand;
- **2146 pass, 2 skip, 0 fail** (2148 tests, 175 files): +17 against 2129/2/0.

No time-outs this run.

**Open questions for the owner:**
1. Point 2 above: steers carried into another client's successor that is then
   cancelled before it starts are dropped silently for their owner (a 4a gap).
   Fix it (a notice, or re-seed the queue), or accept it as "the fate of any
   queued text"?
2. Point 3: accept that the dialog stays until the daemon's withdrawal (one
   round trip)?
3. R0 by hand in your terminal emulator (still open).

### Execution — follow-up 3 (Review round 2)

*— claude-opus-5-5, 2026-10-24*

This follow-up fixes R2-1, R2-2 and R2-3 from "Review — round 2". The Review
sections are untouched.

**Gate baseline:** 2146 pass / 2 skip / 0 fail, lint clean (the end of
follow-up 2).

**R2-1 — `held` now counts only a consumer that will really drain the queue**
(`daemon/src/hosted-session.ts:904-911`).
- *The rule, daemon facts only:*
  `live = (successor && !successor.cancelled) || (controller &&
  !controller.signal.aborted && !compacting)`.
- *What it means:* a text queued only to a reserved send-now that is already
  cancelled, or to a turn that is already aborted, is no longer reported as
  held, so the client restores it.
- *Delivered texts* (`isDelivered`) are held as before.
- *Red test:* the reviewer's repro, ported as **F-7**
  (`daemon/test/send-now.test.ts:1115`), red first with `held: ["a"]` received
  where `[]` was expected.
  - It also asserts the fate: S ends `{cancelled, delivered: false}`, and the
    history stays `["go","go"]`.
  - That history is the gap below. The report now matches it.

**R2-2 — the successor term is pinned.** With the R2-1 fix, the running-turn
term is false whenever the turn is aborted. In F-1 (`:1052`), another client's
send-now aborts my turn, so only the successor term keeps my queued steer held.
M-R4 (remove the successor term) now turns F-1 red.

**R2-3 — the `MethodNotFound` fallback dismisses the dialog, like the latched
path** (`tui/src/App.tsx:834`, `permission.answer(DISMISSED)` before
`old.abort()`).
- `answer` acts on whatever is pending now: the old turn's ask, since only one
  turn runs. When nothing is pending it is a no-op. It never reads a stale
  render's `permission.pending` from the promise callback.
- *Test:* T-C4d (`send-now-app.test.tsx:202`), red first: `answered` was
  `undefined` where `DISMISSED` was expected.

**Debt, not fixed here (a separate `fix` task, the owner's call): a cancelled
consumer drops the queued texts of other clients silently.**
- *Case 1, `endUnstarted`:*
  1. I queue "A" in my turn T1.
  2. Client B's send-now S reserves on T1; T1 is aborted and unwinds.
  3. B presses Esc before S starts, so `cancel()` sets `successor.cancelled`
     (`hosted-session.ts:1239` area).
  4. `settleSuccessor` → `endUnstarted`: S ends `{cancelled, delivered:false}`,
     and only B is told to restore (its own texts).
  5. My carried steer stays in the agent's queue until the next `prompt`
     resets it (`:803`), so "A" is never in the history.
  6. My client sees only `turn_end{T1, cancelled}`. My TUI clears the row at
     T1's end (`onTurnEnd`), and nothing tells me.
- *Case 2, same class:* another client's Esc on MY turn (no successor) also
  drops my undrained steers at the next `prompt`.
- *Repro:* F-7 above, a real `HostedSession`, history `["go","go"]`. The
  original is `.tentacle/tmp/send-now-c/endunstarted.test.ts` (test
  `REVIEW-R2`).
- *What 4c guarantees:* only the honest report. If I chord in that window,
  `held: []` makes my TUI restore "A" into the input. Outside a chord the drop
  is still silent.
- *Fix options for the owner, both 4a contract changes* (Size S–M, Blast
  load-bearing, fresh-context review):
  - (a) carry a cancelled consumer's queue into the next turn instead of
    dropping it;
  - (b) emit a notice/update to the clients whose texts were dropped (by
    enqueue id), so each restores its own.

  One rule should cover both cases. Recommendation: (a) with a cap, because it
  needs no new update kind. Not indexed in `TODO.md` here: that is a separate
  docs edit, and it needs the owner's OK.

**Mutations** (Edit → narrow tests → `cp` from `bak5/`; all red):

| # | Mutation | Red |
|---|---|---|
| M-R4 | `live` without the successor term | F-1 |
| Q2 | successor term without `!cancelled` | F-7 |
| Q3 | turn term without `!signal.aborted` | F-7 |
| Q4 | `MethodNotFound` fallback without `DISMISSED` | T-C4d |

After the mutations the tree was **byte-identical**: `cmp` of both files
against `bak5/`; `git status --short` and `shasum` of `daemon/src` and
`tui/src` diffed with the `*-before5.txt` snapshots, both diffs empty.

**Gate** (`bun run check`): typecheck clean · lint `Checked 418 files … No
fixes applied` · **2148 pass, 2 skip, 0 fail** (2150 tests, 175 files). That is
+2 (F-7, T-C4d) against 2146/2/0. No time-outs this run.

### Execution — follow-up 4 (owner's manual test)

*— claude-opus-5-5 (orchestrator), 2026-10-24*

The owner tried R0 by hand in their terminal (from source on this branch):
`Ctrl+X Ctrl+S` works, with and without a permission dialog. One request:
a keys hint beside the queued rows, like the spinner's "esc/ctrl+c to stop".

- `tui/src/send-now.ts`: `SEND_NOW_HINT = "ctrl+x ctrl+s to send now"` (the
  one copy of the text).
- `tui/src/components/QueuedMessages.tsx`: optional `hint`, rendered beside
  the LAST row only (` · <hint>`, dim); a long row truncates its own text,
  never the hint (row `Box` → text `flexShrink 1`, hint `flexShrink 0`).
- `tui/src/App.tsx`: passes `hint={SEND_NOW_HINT}` (rows render only while a
  turn runs, as before).
- Tests: `queued-messages.test.tsx` (last row only; a 200-char row keeps the
  hint; no prop → no hint) — red before the component change;
  `queue.test.tsx` asserts the App frame shows `also do X · ctrl+x ctrl+s to
  send now` — mutation "App does not pass the hint" → red, restored.
- Gate: 2150 pass / 2 skip / 0 fail, lint clean.
- Not done: the hint does not change while the chord is half-typed (after
  `Ctrl+X`); not requested.

## Review

*— claude-opus-5-5 (reviewer, fresh context), 2026-10-24. Same model family
as the planner and the executor, on the same account: only the context is
fresh, so blind spots they share can survive this pass.*

**Verdict: REQUEST-CHANGES.** One client-side guess remains outside the
older-daemon fallback (finding 1). It contradicts the owner principle this
follow-up exists to enforce. It is narrow (multi-client only) and visible
(it causes a possible duplicate, never a loss). The owner may instead accept
it as a documented approximation; that is the owner's call, not the
reviewer's. Everything else holds.

**Gate** (`bun run check`, re-run by me): typecheck clean · lint `Checked 418
files … No fixes applied` · **2129 pass, 2 skip, 0 fail** (2131 tests, 175
files). The two skips are the opt-in ones. Log:
`.tentacle/tmp/send-now-c/review-gate.log`.

**Findings**
1. **Medium: a guess outside the fallback.** The trigger is a daemon
   `TurnInProgress` while the old turn still runs. Code: `onSendNowError`
   (`tui/src/send-now.ts:53-61`) maps it to `restore`, and the App then runs
   `restoreSending` (`App.tsx:814-826`). The daemon sends that refusal with my
   target still running only when `this.successor !== null`
   (`daemon/src/hosted-session.ts:841-842`). That is another client's send-now,
   which has already aborted my turn. Its successor seeds the old turn's
   undrained steers, mine included (`:916-925`, "foreign … ones too"). So the
   texts the TUI puts back in the input are already accepted steers that the
   daemon will deliver. Enter then duplicates them. T-C10
   (`send-now-app.test.tsx:475`) pins this behaviour as intended. The same
   guess applies after the old turn ended (`assertIdle`, `:861`): the protocol
   (`protocol/src/session.ts:338-341`) says nothing about the fate of the texts
   on `TurnInProgress`, yet the TUI asserts "delivered nothing". The fix needs
   either a fact from the daemon or not restoring rows whose enqueue was
   accepted. It is not a reviewer edit.
2. **Low: test gap. Mutation M-R2 survived.** I replaced `old ?
   restoreSending : takeAll` (`App.tsx:819`) with `takeAll` everywhere: 72/72
   still pass. The distinction from drift item 4 is pinned only in the pure
   tests. `takeAll` while the old turn runs would also restore rows typed
   after the chord, which that turn still holds (a duplicate).
3. **Low: test gap. Mutation M-R1 survived.** I removed the `closed`
   re-check after `await this.opening` (`client/src/remote-session.ts:203-205`):
   72/72 still pass. Nothing pins "`close()` during the first open, then
   `sendNow`".
4. **Low: an orphaned permission ask.** With the dialog up, the chord calls
   `permission.answer(DISMISSED)` (`App.tsx:776`), and over RPC that sends
   nothing (`permission-ui.ts:12`). If the send-now is then refused while the
   old turn keeps running, the daemon stays suspended on an ask nobody shows.
   That is exactly what the comment at `App.tsx:1196-1197` warns about. With a
   live daemon this is reachable only through a non-daemon error (an open
   failure, `UnknownSession`), because a running target is always accepted or
   already aborted.
5. **Nit (AGENTS §7).** Some decision branching still lives in `App.tsx`:
   - which restore shape to use (`:819`);
   - `Cancelled` → `takeAll` + idle (`:661`);
   - `delivered` with or without the old turn (`:828`);
   - `settleSendNow`'s atomic-vs-fallback split (`:592`).

   They are tested through Ink, not in `send-now.ts`. This fits the known
   key-handler debt, but it is new logic.

**Premise table**

| Premise | Status |
|---|---|
| `hosted-session.ts:850-866`: an ended target → assertIdle, then a turn, a continuation, or `NoTurnRunning` | TRUE (`:851-870`) |
| `protocol/src/session.ts:334-356`: a stale target never cancels another turn | TRUE (`:338-341`) |
| `remote-session.ts:68-75`: `turnId` is kept after the end on purpose | TRUE |
| `RemoteClient.sendNow` is keyed (re-sent after a drop, run once) | TRUE (`remote-client.ts:518-523`) |
| `/clear` resets both latches; `/clear` is session-mutating (it waits for idle) | TRUE (`App.tsx:910-917`, `commands.ts:156`) |
| `persistingController.sendNow` saves the new turn when it settles | TRUE (`cli/src/local-runtime.ts:147-169`) |
| Symptom repro (capability missing on `main`) | not re-run: the feature now exists; the 12 App reds against `HEAD:App.tsx` are the executor's |

**Question 1: does 4b still hold?** Yes, with finding 1 as the exception.
- **Racing the old `turn_end`:** the request goes to `next`. The daemon finds
  the target ended and starts the successor at once. The old `turn_end`
  precedes its updates, so `promote` routes them correctly. A refusal clears
  `next`, or un-installs it and reverts `turnId` (`:253-264`).
- **Racing the first open:** `runTurn`'s `await` was registered first, so its
  turn is installed and its prompt written before the `send_now` (CF-3).
- **`closed` during the await:** re-checked, but untested (finding 3).
- **Idempotent retry:** `known`/`successor` dedup comes before any target
  check (`:834-840`).
- **Resync while pending:** unchanged 4b paths.
- **D4 (only my rows):** the request cites only my ids. The daemon answers
  per id, and its continuation decision is structural, not by text.

**Question 2: guesses left?** One, finding 1: `TurnInProgress` → restore.
`NoTurnRunning` is now the daemon's fact.
- **The fallback's own guess** (`afterOldTurn`) is bounded to `MethodNotFound`
  or a missing `sendNow`.
- **It is documented** in `send-now.ts:68-84` and `PendingSendNow`.
- **It is latched** once per session.

**Question 3: rows lost or sent twice?**
- **Silently lost: none found.** A refused late enqueue keeps today's "not
  queued" notice. A taken row's refusal is silent by design (T-C11).
- **Sent twice:** finding 1, plus finding 2's latent variant.
- **`/clear` mid-chord:** not reachable while running.
- **The 1500 ms window:** pure, and tested at 1499 and 1501 ms.
- **Quit:** the successor runs unobserved and is not saved laptop-side, as
  documented.

**Attacks tried**
- **Ended-target matrix against the daemon:** reading the code found
  finding 1.
- **Two new mutations:** both survived (findings 2 and 3).
- **Dialog + refusal:** finding 4.
- **The `persistingController` path after a send-now turn:** holds.
- **`/clear` during a pending send-now:** blocked by `isSessionMutating`;
  holds.

No separate end-to-end scratchpad: R1 (`client/test/reattach.test.ts:533`,
a real `SessionHost` restart) is the end-to-end trace, and it passes in the
gate.

**Mutations**
- M-R1 and M-R2 were applied with Edit, then the narrow files were run
  (`client/test/send-now`, `client/test/reattach`,
  `tui/test/send-now-app`): **72/72 green on both, so both survived.**
- Each file was then restored with `cp` from
  `.tentacle/tmp/send-now-c/rev-bak/`.
- `shasum` after the restore: `d3b6ee2f…`/`5dc2b434…`, identical to the
  values before.
- `git status --short` diffed with the pre-mutation snapshot: empty.

**How the executor behaved.** Honest and thorough:
- Drift is listed item by item.
- Two mutations that first survived (M6, M10) were reported, and the tests
  were strengthened for them.
- Unverified points were flagged (the old restart claim, later closed by R1).

The blind spot is the same one the principle targets: "refusal ⇒ delivered
nothing" was carried over from 4b's `Cancelled` semantics to every non-NTR
code without checking `TurnInProgress` against `hosted-session.ts:841`/`:918`.

### Review — round 2

*— claude-opus-5-5 (reviewer, same fresh-context session as round 1),
2026-10-24. The planner and executor are the same model family. The change now
touches the daemon and the protocol, so it is reviewed as LOAD-BEARING. AGENTS
§10 would prefer a different model for that.*

**Verdict: REQUEST-CHANGES. One small daemon fix, in this task.** Round 1's
findings are closed. One new finding: the daemon's new `held` fact is false in
one reachable window, so a refusal there turns into a silent loss. The fix is a
few lines in the code this follow-up added, so it belongs in 4c.

**Gate** (`bun run check`, re-run): typecheck clean · lint `Checked 418 files …
No fixes applied` · **2146 pass, 2 skip, 0 fail** (2148 tests, 175 files). The
skips are the opt-in ones. Log: `.tentacle/tmp/send-now-c/review2-gate.log`.

**New findings**
- **R2-1. Medium: `held` claims texts the daemon is about to drop**
  (`daemon/src/hosted-session.ts:903`).
  - *The window:* another client's send-now is reserved on my turn and then
    cancelled before it starts (`successor.cancelled = true`, `:1239`).
  - *Why the report is wrong:* `live` stays true in that window through either
    term. The successor is still non-null, and the old turn's controller is
    still non-null (it is unwinding).
  - *What happens:* a chord of mine in that window is refused with
    `held: ["a"]`. The TUI then keeps the row `queued` instead of restoring it.
    The successor ends via `endUnstarted`, my old turn ends, `onTurnEnd`
    clears the row, and "A" is never sent.
  - *Repro* (`.tentacle/tmp/send-now-c/endunstarted.test.ts`, test
    `REVIEW-R2`, a real `HostedSession`):
    `REFUSAL {"code":-32004,"data":{"held":["a"]}}` ·
    `S END {…"stopReason":"cancelled","delivered":false}` ·
    `USERS ["go","go"]`, so "A" is not in the history and no notice is shown.
  - *Proposed fix:* a queued id is held only if a turn that WILL drain it
    exists: `(successor && !successor.cancelled) || (controller &&
    !controller.signal.aborted && !compacting)`. A test with this repro's
    shape must expect `held: []`.
  - *Scope:* the drop itself is the 4a gap below (accepted for now). R2-1 is
    the false report about it, introduced here.
- **R2-2. Low: the successor term is untested.** Mutation M-R4 removed
  `this.successor !== null ||` (`:903`), and 39/39 daemon tests still pass.
  With the R2-1 fix, the term is only reachable for a compaction-target
  successor (the 4d path). Pin it there, or with the R2-1 test.
- **R2-3. Nit: two dialog paths disagree.** After `MethodNotFound`, the
  atomic attempt's fallback aborts the old turn (`App.tsx:833-835`) without
  `DISMISSED`. The latched fallback does dismiss (`:779-781`). If an older
  daemon does not withdraw the ask on cancel, its dialog stays up for a dead
  request. Answering it is harmless, because the daemon ignores a late
  answer. Cosmetic.

**Round-1 findings**
- **1. Closed** (except for R2-1). `held` comes from daemon facts only: id
  sets `drained`, `restoredIds` and `steeringIds`, never text or shape. I
  verified the F-1…F-6 fate table by mutation P3 (delivered ids not held):
  F-2, F-3 and F-5 turn red.
- **2. Closed.** My M-R2 re-run as `oldRunning=false` (`App.tsx:815`): T-C10
  and T-C10b turn red.
- **3. Closed.** My M-R1 re-run (no `closed` re-check): CF-4 turns red.
- **4. Closed.** The atomic chord no longer dismisses the dialog.
  - The withdrawal chain holds by composition. An accept aborts the turn, the
    daemon emits `permission_resolved{cancelled}` (daemon T-A6), and the
    client router aborts the dialog's signal on it (`client/test/remote.test.ts:633`).
  - Single broker: nothing is sent on withdrawal, and a key in the round-trip
    window answers a request the daemon has already settled, which it ignores.
  - Ctrl+C is unchanged (`:1188`).
  - P6 (dismiss again) turns T-C4c red.
  - Not covered: a real end-to-end test of daemon + client + TUI for this
    chain. T-C4 uses a fake withdrawal.
- **5. Mostly closed.** The decisions now live in `planRefusal`,
  `afterRefusal` and `onSuccessorError`. The remaining dispatches are listed
  as debt and are acceptable.

**Load-bearing red-team (§7 protocol)**
- **Forward compatibility.** `error.data` is a free field (§7 "fields are
  free"). `peer.ts:359`/`:442` carry it both ways, and CF-5 shows the client
  passes it on untouched. `SendNowRefusalSchema` is a strip schema
  (`additionalProperties: true` in the regenerated `protocol.json`).
  - *Older client:* it ignores the field.
  - *Older daemon:* it sends no `data`, so `heldIds` returns null, and the TUI
    restores every `sending` text (T-C10b). That is a possible duplicate,
    never a loss.
  - *TUI parsing:* the TUI validates the field by hand, because it does not
    depend on `@tentacle/protocol`. Malformed data → null → restore all
    (fail-safe).
- **No `PROTOCOL_VERSION` bump: honest.** No meaning or field changed. It is
  not an update kind (`UPDATE_CLASS` does not apply), and every mixed pair
  converges to the documented fallback.
- **Throw sites.** Only `:843` and the `assertIdle` catch exist, and both are
  wrapped. `known` and `successor` retries return earlier.
  - Other errors from the request carry no `data`, so the TUI restores all.
    That is correct: such a session is gone, or the request never ran.
- **Idempotent retry.** A refused attempt is not recorded, so a keyed re-send
  after a drop recomputes `held` from the current facts.
- **Multi-client.** `held` names only the caller's ids (D4). F-1 shows another
  client's successor carries my steer exactly once.

**The 4a gap the executor flagged (`endUnstarted`): confirmed** by the same
repro: "A" is silently gone, and my client only sees `turn_end{T1,
cancelled}`. **Recommendation: a separate `fix` task, not 4c.**
- **Size and blast:** `fix/…`, Size S–M, Blast load-bearing. It changes the 4a
  contract: re-seed the dropped queue into the next turn, or notify the owners.
  It needs its own design and a fresh-context review.
- **It is a pre-existing class:** another client's Esc on my turn already
  drops my queued rows silently. The fix should cover both cases with one
  rule.
- **Index it:** record the task in `TODO.md`.
- **4c's part is R2-1:** report it honestly as not held, so the TUI restores
  the texts.

**Mutations (round 2)**

| # | Mutation | Result |
|---|---|---|
| M-R4 | daemon `live` without the successor term | 39/39 pass: **survived** (R2-2) |
| P3 (executor's, re-run) | delivered ids not held | F-2, F-3, F-5 red |
| P6 (executor's, re-run) | atomic chord dismisses the dialog | T-C4c red |
| M-R1 (round 1, re-run) | no `closed` re-check | CF-4 red |
| M-R2 (round 1, re-run) | `oldRunning=false` | T-C10, T-C10b red |

Each mutated file was then restored with `cp` from
`.tentacle/tmp/send-now-c/rev2-bak/`.
- `shasum` after the restore is identical to the pre-mutation values:
  `hosted-session.ts af73a182…`, `App.tsx 9a9f3508…`, `send-now.ts 1995a904…`,
  `remote-session.ts d3b6ee2f…`.
- `git status --short` diffed with the snapshot: empty.

**Attacks tried**
- **A false `held` in the cancelled-successor window:** found R2-1 (repro).
- **Redundancy of each `live` term:** found R2-2.
- **Dialog dismiss/withdraw across all three chord paths:** found R2-3; the
  rest holds.
- **Older peers in both directions:** holds.
- **Retry after a refusal:** holds.
- **Data loss through `persistingController` / RPC wrappers:** holds (CF-5).

**How the executor behaved.**
- **Fixes:** every finding was fixed with a red-first test, and the fixes were
  verified against the code.
- **Fate table:** each row was asserted on the actual fate, not only on the
  report.
- **Disclosure:** the 4a gap and the dialog-timing nuance were disclosed
  without being asked.
- **Blind spot:** the fate table had no row for "the successor that carries
  my steers gets cancelled". That is exactly where `held` lies.

### Review — round 3

*— claude-opus-5-5 (reviewer, same session as rounds 1–2), 2026-10-24.
Same model family as the executor; see round 2's caveat.*

**Verdict: APPROVE.** R2-1, R2-2 and R2-3 are closed, each verified with my
own mutation. I found no regression.

**Closures**
- **R2-1** (`daemon/src/hosted-session.ts:904-915`): `live` now requires a
  successor that is not cancelled, or a running turn that is not aborted.
  - *My mutation:* revert `live` to the round-2 code (`next !== null ||
    (turn !== null && !compacting)`). F-7 turns red.
- **R2-2:** F-1 now pins the successor term.
  - *My mutation:* M-R4, dropping the successor term. F-1 turns red (39 pass,
    1 fail).
- **R2-3** (`tui/src/App.tsx:838`): `permission.answer(DISMISSED)` runs
  before `old.abort()`.
  - `answer` is ref-based and stable (`permission-ui.ts:125-131`). It acts on
    whatever is pending now, so it is not affected by a stale render.
  - *My mutation:* remove that line. T-C4d turns red.

**Regression check** against the cases in round 2's table:
- **Compaction in progress:** unchanged. The turn term already excluded
  `compacting`; F-5 and F-6 still pass.
  - A queued text with no live consumer is now reported as not held, so it is
    restored. That gives at worst a visible duplicate, never a silent loss,
    which is what the field's contract promises (`SendNowRefusalSchema` doc).
  - Only a successor the daemon is actually waiting on counts as live. That
    includes a compaction-target successor that is not cancelled, which
    carries the queue over.
- **F-1 to F-4:** pass.
- **My own turn aborted, with my target still current:** never refused, because
  `running` makes the daemon accept the request (`:851-858`). So the new
  `signal.aborted` guard cannot hide a held text of mine.

**Debt description** (follow-up 3, "Debt, not fixed here"): accurate.
- It matches my repro: history `["go","go"]`, S ends `{cancelled,
  delivered:false}`, and T1 ends `cancelled` with no notice.
- Case 2 (another client's Esc on my turn) is the same mechanism as F-4.
- The options and the size/blast rating are reasonable. Indexing it in
  `TODO.md` is left to the owner.

**Gate:**
- My first run overlapped my own mutations, so it is invalid (exit 1). I
  discarded it and re-ran on the restored tree.
- `bun run check`: typecheck clean · lint `Checked 418 files … No fixes
  applied` · **2148 pass, 2 skip, 0 fail** (2150 tests, 175 files). Log:
  `.tentacle/tmp/send-now-c/review3-gate-clean.log`.

**Tree:** each file restored with `cp` from `.tentacle/tmp/send-now-c/rev3-bak/`.
- `shasum`: `hosted-session.ts 8182172e…` and `App.tsx 5567e22e…`, identical
  to the values before.
- `git status --short` diffed with the snapshot: empty.

> **Carry-overs added by the orchestrator (2026-10-23), from 4a/4b — re-verify on promotion:** see `docs/eval/send-now.md` "Addendum — decisions taken during execution" items 2–11. In short: `createSession` still returns `SessionController` (widen it for `sendNow`); a local `NoTurnRunning` must not be silent (queued texts still reach the daemon); enqueue during compaction while a send-now request is in flight is uncovered by 4b; continuation turns have prompt `""` (render them); after a daemon restart an idle `[system?, user]` history answers `NoTurnRunning`.
