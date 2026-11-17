# feat/mobile-session-actions — Long-press row actions in the sessions drawer: Rename, Delete, Pin

> **Status:** implementation APPROVED (orchestrator, night delegation 2026-11-17)
> **Branch:** `feat/mobile-session-actions`
> **Size:** M overall, split S1 (M) · S2 (M) · S3 (S) · **Blast:** S1 load-bearing (persisted sidecar + protocol, additive) · S2 contained (mobile) · S3 cross-module (TUI) · **Suited:** S1 strong model + mandatory fresh-context Review (red-team the persistence and protocol invariants of AGENTS §7); S2/S3 any model + standard Review
> **Changelog:** `changelog.d/mobile-session-actions.added.md` (`- **Session actions on iPhone.** Long-press a session in the drawer to rename, pin to top or delete it; pins are stored on the computer, so the phone and the Mac see the same order.`)

## Context

*— claude-opus-5-5, 2026-11-17*

Owner, 2026-11-17: in the iPhone sessions drawer
(`apps/mobile/src/screens/SessionsDrawer.tsx`), a LONG-PRESS on a session row
should give haptic feedback and a small native-feeling menu with **Rename**,
**Delete** (confirmed) and **Pin to top** / **Unpin**. Pinned sessions sort
first, are persisted, and are the SAME on every device that looks at that
host (phone and Mac). Owner taste: minimal, thin glyphs, iOS action sheet; no
mockups (autonomy). Reuse existing RPCs; protocol changes additive.

What exists today (verified):

- Long-press already opens a one-item action sheet: **Rename** only
  (`SessionsDrawer.tsx:288-305`, `onLongPress` at `:454`, a11y hint "Long-press
  to rename" at `:453`). Rename is fully built: `drawer-rename.ts` (pure
  controller, `createDrawerRename`), `session-rename.ts` (`renamePlan`,
  `renameErrorText`), `RenameSheet.tsx`, wired in `App.tsx:1050,1110,1207-1209`.
  It calls `session/rename` by id, which needs no open and renames an archived
  session in place (`packages/protocol/src/session.ts:1268-1279`).
- No haptic on long-press (`playHaptic` is not used by the drawer;
  `haptic-rules.ts:13` has kinds `light | firm | success | tick | commit`).
- Delete exists on the wire and in the client: `session/delete`
  (`protocol/src/session.ts:1248-1259`: ends a live session first,
  `session_closed{deleted}` to every attached client, tombstone survives a
  restart, idempotent) and `RemoteClient.deleteSession`
  (`packages/client/src/remote-client.ts:1780`). The TUI `/sessions` panel
  already deletes with a confirmation that warns about a running turn
  (`packages/tui/src/sessions-panel.ts:170-185`, owner R3 2026-10-26) and
  refuses the current session. The phone has no delete.
- No pin anywhere: no method, no list field, no stored field (`rg -i pin`
  over `protocol/src/methods.ts`, `daemon/src/daemon-state-file.ts`,
  `daemon/src/session-list.ts` → only unrelated words).
- `session/list` order is `updatedAt` desc, then `sessionId` asc, keyset
  paged at most 200 per page (`protocol/src/session.ts:1438-1497`,
  `daemon/src/session-list.ts:7-11,69-104`). The phone reads pages with a
  cursor and "More" (`apps/mobile/src/session-list-controller.ts:27,70-73,153`).
  So a client that only hoists pins from the pages it has loaded misses a pin
  older than the first page.

Scope of "every device": the phone only ever reaches a `serve` daemon (via the
relay); the Mac sees the same sessions through `connect` (`/sessions` reads
`session/list`, `packages/cli/src/connect-resume.ts`, and `connect` keeps no
laptop copy, AGENTS §7). So the single source of truth for a pin is **that
`serve` daemon**. Laptop-local sessions (plain `tentacle`, in-process worker,
the laptop's own `<uid>.jsonl` store) are invisible to the phone; see Owner
question 1.

**Repro** (2026-11-17, worktree at `5885a501`, from
`.tentacle/tmp/mobile-session-actions/`, i.e. the capability is missing):

```
$ rg -n 'label: "' apps/mobile/src/screens/SessionsDrawer.tsx
295:            label: "Rename",
418:            action={{ label: "Retry", onPress: props.onRetry, testID: "drawer-retry" }}
$ rg -n -i 'pin' packages/protocol/src/methods.ts packages/daemon/src/daemon-state-file.ts packages/daemon/src/session-list.ts
packages/daemon/src/session-list.ts:22:import { wireLine } from "./mapping.ts"
packages/daemon/src/daemon-state-file.ts:56: *    would reload as a plain message — a half-load. Stamping 2 makes that
packages/protocol/src/methods.ts:4: * before handling, and validates `result` before replying. Keeping this in one
$ rg -n 'playHaptic' apps/mobile/src/screens/SessionsDrawer.tsx
(no output)
```

The row menu has only Rename; nothing on the wire, on disk or in the list
knows a pin; the long-press plays no haptic.

## Implementation

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**A pin can live in the `serve` daemon's per-session state sidecar as one
optional field, written for live AND archived sessions without touching the
conversation log or `updatedAt`, and surfaced by `session/list`.** Evidence:

- The sidecar is the daemon's non-conversation state and already carries
  optional switches with the "absent = off, readable by an older build" rule:
  `autoAccept?` (`daemon/src/daemon-state-file.ts:101-107`, written only when
  true at `:145-147`, parsed fail-closed at `:416-419`) and `archivedAt?`
  (`:99`). `parseSidecar` rebuilds the value from known fields only
  (`:400-421`), so an unknown optional field is ignored by an older build, not
  refused: no `DAEMON_STATE_VERSION` bump is needed for an optional field
  whose loss is harmless.
- A live switch persists itself with `this.persist()` and no lock
  (`daemon/src/hosted-session.ts:2873-2891`, `setAutoAccept`).
- An archived session is changed in place without reopening, rewriting only
  its state file: `SessionHost.rename` → `rewriteArchived`
  (`daemon/src/session-host.ts:1022-1044, 1067-1100`).
- Rename does not move `updatedAt` (`protocol/src/session.ts:1276`), and
  `toSessionList` keys on the stored `lastChangeAt`, never the clock
  (`daemon/src/session-list.ts:89-94`). A pin must follow the same rule.
- Every `session/list` entry comes from `SessionSummary`
  (`daemon/src/session-list.ts:25-45`): the live one from
  `HostedSession` (`hosted-session.ts:1650`), the archived one from
  `ArchivedEntry` (`session-host.ts:435-467`). Adding `pinnedAt?` there is the
  one place both kinds pass through.

A pin is not conversation, so per AGENTS §7 ("persist only the
conversation") it must NOT be a log entry. That also answers the brief's
guard: **no new log entry, critical or not.**

### Preconditions

- Peer dispatch is concurrent and host-level handlers are synchronous
  (`daemon/src/connection.ts:464-470`, the `Rename` case: "needs no `open`").
  `session/pin` is the same shape, so two devices pinning are applied in one
  total order with no lock (AGENTS §7 "Don't serialize the RPC peer").
- Payloads are strip schemas (AGENTS §7 forward compat): a new optional entry
  field and a new optional result field are dropped by an older client, and a
  new method is `MethodNotFound` on an older daemon. Additive → **no
  `protocol.d/` note**. `protocol.json` is regenerated by the orchestrator's
  `bun run protocol:bump` at merge.
- Only a `serve` daemon has a persister (`startDaemon`, AGENTS §7). On a pod
  daemon or the in-process worker a pin lives in memory only and is lost with
  the session. Nothing reaches those from the phone today.
- `session/delete` and `session/rename` already exist with the error
  vocabulary the phone maps (`SessionDeleted`, `UnknownSession`,
  `MethodNotFound` → `renameErrorText`, `docs/feat/mobile-chrome.md` F7).
- The deleted-session state already reaches the open session screen
  (`apps/mobile/src/session-controller.ts:28,93` `"deleted"`).
- **To verify first in S2 (not yet proven):** that the drawer re-reads its
  computer's list each time it opens. If it does not, S2 adds that re-read,
  because the other device's pin only shows after a re-read.

### Design

**Wire (S1).**

- New method `session/pin` (`Method.Pin = "session/pin"`):
  params `{ sessionId, pinned: boolean }`. Result `{ pinned: boolean }` (the
  state after applying). It is a **set, not a toggle**: idempotent, and two
  devices sending the same intent converge. Host-level, needs no `open`, works
  on live and archived sessions. A deleted id → `SessionDeleted`; an unknown
  id → `UnknownSession`. Pinning a new session past `MAX_PINNED_SESSIONS`
  (20, Owner question 4) → `InvalidParams` with "at most 20 pinned sessions:
  unpin one first". Re-pinning an already pinned session is a no-op success,
  never a cap error. Does not move `updatedAt`. Emits no update (list
  metadata: other devices see it at their next `session/list`, Owner
  question 6).
- `SessionListEntrySchema` gains `pinned: z.literal(true).optional()`
  (absent = not pinned, the `autoAccept` rule).
- `SessionListResultSchema` gains `pinned: z.array(SessionListEntrySchema)
  .max(MAX_PINNED_SESSIONS).optional()`: present only on the FIRST page (no
  `cursor`), every pinned session on the daemon, live or archived, in the same
  `updatedAt`-desc order. Those entries ALSO stay in their normal place in
  the recency pages (with `pinned: true`). So the keyset paging and its
  cursor do not change, and an older client that drops both fields sees
  exactly today's list. The client dedupes by `sessionId`.

**Daemon (S1).**

- `SessionSummary.pinnedAt?: number` (`daemon/src/session-list.ts:25`).
  `toSessionList` sets `pinned: true` on the entry, and when
  `params.cursor === undefined` builds the `pinned` array from every summary
  with `pinnedAt` (not filtered by the cursor, sorted with `compare`).
- `HostedSession.pinnedAt: number | undefined`: restored from the record,
  carried in `summary`, in the persisted state (`session-persister.ts:545`
  is where `autoAccept` joins), and `setPinned(on)` mirrors `setAutoAccept`:
  if changed, set (`now()` when pinning) and `this.persist()`.
- `ArchivedEntry.pinnedAt` (read from the sidecar when indexing, like
  `title`). `SessionHost.pin(id, on)` mirrors `rename`: tombstone check →
  live → archived (set `entry.pinnedAt` and mark it changed, then
  `void this.rewriteArchived(entry, "pinned")`). `rewriteArchived`'s
  "nothing changed" guard (`session-host.ts:1080-1083`) and both its write
  paths (the resident record and the loaded state) must carry the pin.
  Reopen: the record's `pinnedAt` flows into the live session (the
  `withoutReclaimed(...)` site at `session-host.ts:924-930`).
- The cap is counted over live + archived summaries inside the synchronous
  handler (no await between count and set).
- Sidecar: `DaemonSessionRecord`/`DaemonSidecar` gain `pinnedAt?: number`,
  written only when set, parsed with `isWireStamp`. **A malformed value is
  dropped, not refused** (like `autoAccept`: the conversation is intact and
  a lost pin is harmless). No version bump.
- `delete` needs nothing new: the record and its sidecar go, and with them
  the pin.

**Client (S1).** `RemoteClient.pinSession(sessionId, pinned): Promise<boolean>`
beside `deleteSession`. The list mapping keeps `pinned` and the first page's
`pinned` array (values validated by the schema; a pod daemon is untrusted,
but these are booleans and bounded entries).

**Mobile (S2).** Pure modules carry the logic; the components only render.

- `drawer-row-menu.ts` (new, pure): `rowMenu(row): readonly RowMenuItem[]`
  gives, in order, `Pin to top` | `Unpin` (by `row.pinned`), `Rename`,
  `Delete` (destructive, last). It also builds the delete confirmation:
  `deleteConfirm(row, { isOpen })` → `{ title, message, confirmLabel:
  "Delete" }`, where the message says what is lost and adds "Its running turn
  will stop." when `row.running` (the TUI's owner R3 wording,
  `sessions-panel.ts:176-185`), "It is open on another device." when
  `attached > 0`, and "This is the session you are in." when it is the open
  one.
- `drawer-row-actions.ts` (new, pure controller in the `drawer-rename.ts`
  style): `pin(computerId, row)` and `confirmDelete(computerId, row)` →
  `deleteNow()`. One action in flight per row (a second tap sends nothing).
  The call goes to the computer that listed the row (as `drawer-rename.ts`
  does: the drawer may list a computer other than the open session's). On
  success it re-reads that computer's list. On failure it exposes an
  `error` string for a `Banner` (reusing `renameErrorText`'s mapping:
  offline, `MethodNotFound` → "Update tentacle on <computer> to pin
  sessions", `SessionDeleted` → treated as success for delete). **Never
  queued in the outbox**: a destructive or list action while offline fails
  loudly at once.
- Deleting the OPEN session (Owner question 2): on success the controller
  emits `navigate(nextRow | null)`. `nextRow` is the first remaining
  non-archived row of that computer, in drawer order. `null` → the existing
  empty drawer state with the New session pill. The `session_closed{deleted}`
  that the open screen also receives stays as it is.
- `session-list.ts`: `SessionRow.pinned: boolean`. The list state keeps the
  first page's `pinned` entries (replaced on every first-page read, so an
  unpin on another device clears it). `rows()` returns `sections.pinned`
  (the deduped union of the first-page `pinned` and any loaded entry with
  `pinned: true`, minus archived when Owner question 3 says so), and removes
  those ids from `active`.
- `drawer-list.ts`: a **Pinned** section above Running
  (`DrawerSection = "pinned" | ...`, label `"Pinned"`). Its rows keep their
  tone (a running pinned row keeps its dot). `drawerItems` emits it only when
  non-empty. `session-groups.ts` gets the same `pinned` group, so the full
  Sessions screen agrees with the drawer (one projection, two renderers).
- `haptic-rules.ts`: `rowMenuHaptic(): HapticKind` → `"firm"` (iOS context
  menus use a medium impact). The drawer calls `playHaptic` in `onLongPress`
  before opening the sheet.
- `SessionsDrawer.tsx` (render only): the existing `ActionSheet` gets the
  `rowMenu` items (`destructive: true` on Delete, which `ActionSheet` already
  supports, `ui/ActionSheet.tsx:19`). A second `ActionSheet` shows the delete
  confirmation (title, message, destructive "Delete"). A thin `pin` glyph
  (SF Symbol `pin`, weight `light`, `palette.sec`, 11 pt) goes before the
  meta of a pinned row. The a11y hint becomes "Long-press for actions".
  New testIDs: `drawer-row-pin`, `drawer-row-unpin`, `drawer-row-delete`,
  `drawer-delete-confirm`, `drawer-delete-cancel`, `drawer-pinned`,
  `drawer-action-error`.
- `App.tsx`: wire the controller (as `createDrawerRename` is wired at
  `:1110`) with `link.client.pinSession` and `link.client.deleteSession`.

**TUI parity (S3).** `connect`'s `/sessions` panel (`sessions-panel.ts`,
`sessionsView`) shows pinned sessions first, from the same first-page
`pinned` array and dedupe rule, with a thin `·` pin marker (Owner taste: no
emoji). Pinning from the TUI is Owner question 5.

### Files

S1 (protocol → daemon → client):
1. `packages/protocol/src/methods.ts`: `Pin: "session/pin"`.
2. `packages/protocol/src/session.ts`: `PinParamsSchema`, `PinResultSchema`,
   `MAX_PINNED_SESSIONS`, entry `pinned?`, result `pinned?`, and the method
   table registration the other methods use.
3. `packages/daemon/src/daemon-state-file.ts`: `pinnedAt?` in the record,
   `sidecarOf`, `parseSidecar` (dropped if malformed), the loader
   (`:515` area).
4. `packages/daemon/src/session-persister.ts`: carry `pinnedAt` in the state
   it captures (beside `autoAccept`, `:545`).
5. `packages/daemon/src/hosted-session.ts`: field, restore, `summary`,
   `setPinned`.
6. `packages/daemon/src/session-list.ts`: `SessionSummary.pinnedAt?`, the
   entry flag, the first-page `pinned` array.
7. `packages/daemon/src/session-host.ts`: `pin()`, `ArchivedEntry.pinnedAt`,
   index read, `rewriteArchived` guard + both paths, reopen carry, the cap.
8. `packages/daemon/src/connection.ts`: `case Method.Pin`.
9. `packages/client/src/remote-client.ts`: `pinSession`, the list mapping.

S2 (mobile): `apps/mobile/src/drawer-row-menu.ts` (new),
`drawer-row-actions.ts` (new), `session-list.ts`, `drawer-list.ts`,
`session-groups.ts`, `haptic-rules.ts`, `screens/SessionsDrawer.tsx`,
`screens/SessionsScreen.tsx` (Pinned group header only), `App.tsx`; tests
under `apps/mobile/test/`.

S3 (TUI): `packages/tui/src/sessions-panel.ts` (+ its test).

Docs: this file; `changelog.d/mobile-session-actions.added.md`;
`docs/feat/mobile-chrome.md` line ~225-227 ("Archive/Delete stay out") gets a
pointer to this task.

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| Row's computer offline / link down | Pin and Delete fail at once with "Not connected to <computer>" in a drawer banner. They are never queued: a delete replayed later, after the person changed their mind, is worse than an error. The row is unchanged. Rename keeps its F7 behaviour. |
| Older daemon (`MethodNotFound` on `session/pin`) | Banner "Update tentacle on <computer> to pin sessions". There is no capability probe (pre-public, AGENTS §7). Delete and Rename still work. |
| Older phone, newer daemon | Drops `pinned` fields: today's order, no menu items. |
| Daemon downgraded after pinning | The older build ignores `pinnedAt` and drops it on its next sidecar write: pins are lost, nothing else is. Accepted, like `autoAccept` (documented here, not designed out). |
| Delete the OPEN session | Confirmation says so. On success, navigate to the next row or the empty state (Owner question 2). The screen's own `session_closed{deleted}` is harmless if it lands first. |
| Delete a RUNNING session | The confirmation warns that its turn stops (and that it is open on another device when `attached > 0`). The daemon aborts the turn and tells every client (`session_closed{deleted}`). |
| Delete while the row was already deleted elsewhere | `session/delete` is idempotent: success, list re-read, row gone. |
| Delete fails mid-way (link drops after send) | `endSession` rejects. The banner shows the error. The re-read on reconnect shows the truth (the tombstone means the session is never recreated). |
| Rename empty / whitespace / unchanged / too long | Existing `renamePlan`: no-op or refused in the field. Server-side `InvalidParams` is mapped. |
| Rename "collision" (same title as another session) | Allowed: titles are labels, sessions are addressed by id. No uniqueness check (Owner question 7). |
| Two devices pin the same session at once | Same intent → idempotent. Opposite intents → the synchronous handler applies them in one order, last wins, and both devices converge at their next list read. |
| Two devices pinning the 20th and 21st at once | The count and the set are in one synchronous handler: exactly one gets the cap error. |
| Pin an ARCHIVED session | Allowed (sidecar rewrite, no reopen, `rewriteArchived`). Shown per Owner question 3. Reopen keeps the pin. Archiving keeps the pin. |
| Pinned session deleted | Its record goes with its pin. The `pinned` array no longer lists it. |
| Sidecar rewrite for an archived pin fails | As rename: kept in memory (listed), reported, retried by the sweeps (`session-host.ts:1067-1078`). |
| Pin older than loaded pages | Shown anyway: the first page's `pinned` array carries every pin. |
| Malicious/pod daemon | Booleans and schema-bounded entries only. Titles are already one line and control-free (`session-list.ts:1-5`). |

### Tests

Red before green for every new property (§9). Fakes: the daemon tests'
in-memory persister and `SessionHost` harness. On mobile, pure tests of
controllers with injected `pin`/`delete` fns, in the `drawer-rename.test.ts`
pattern.

S1:
- `session-list.test.ts`: `pinned: true` on the entry. The first page
  carries every pinned summary (also one that sorts past `limit`). A cursor
  page carries no `pinned` array. The order and cursor of `sessions` are
  identical with and without pins (the property that keeps paging intact).
- `session-host` tests: pin live → listed pinned, `updatedAt` unchanged,
  `persist` called. Pin archived → state file rewritten, log untouched, not
  reopened. Reopen keeps the pin. Deleted → `SessionDeleted`. Unknown →
  `UnknownSession`. The 21st pin → `InvalidParams`. Re-pin at the cap → ok.
  Restart (reload from disk) keeps the pin.
- `daemon-state-file.test.ts`: round-trip `pinnedAt`. Absent stays absent. A
  malformed value loads with no pin (not refused). Unknown-field tolerance
  pinned by test.
- Protocol: schema accepts/rejects. A connection-level round-trip of
  `session/pin`.
- Mutation check: drop `pinnedAt` from `sidecarOf` → the restart test fails.

S2:
- `drawer-row-menu.test.ts`: item order and labels for pinned/unpinned. The
  confirmation message for idle / running / attached / open.
- `drawer-row-actions.test.ts`: goes to the row's computer. Re-reads on
  success. Error string on reject (offline, `MethodNotFound`).
  `SessionDeleted` on delete = success. A double tap sends once. Deleting the
  open row navigates to the next row, or `null`.
- `session-list.test.ts` / `drawer-list.test.ts` / `session-groups.test.ts`:
  the Pinned section first, deduped, removed from Running/Recent. Replaced
  (not merged) on a first-page re-read. Archived handling per Owner
  question 3.
- `haptic-rules.test.ts`: `rowMenuHaptic() === "firm"`.

S3: `sessions-panel` test that pinned rows render first, with a marker.

Gate per slice: narrow test files. Before done: `bun run check` (typecheck
includes `tsc -p apps/mobile`).

### Owner questions

1. **Laptop-local sessions (not `serve`).** Should they be pinnable too? The
   phone never sees them. *Rec: out of scope. A pin lives on the `serve`
   daemon, the one store phone and `connect` share. A later per-host
   `<configDir>/sessions/pins.json` index can cover the local TUI picker,
   never a log entry.*
2. **Deleting the session you are in.** The TUI refuses it. *Rec: allow on
   the phone, with "This is the session you are in" in the confirmation, then
   open the next session of that computer (or the empty drawer).*
3. **Archived + pinned.** *Rec: Pin is offered on archived rows too. A
   pinned archived row shows in Pinned (dimmed, archive glyph), and a tap
   browses it without reviving (Q4 rule).*
4. **Pin cap.** *Rec: 20 per daemon. Past that, a clear "unpin one first"
   error. It bounds the first-page `pinned` array.*
5. **Pin from the Mac TUI.** *Rec: S3 only SHOWS pins first (read parity). A
   `p` key in `/sessions` comes as a follow-up S task if you want it.*
6. **Live push of pin changes to other devices.** *Rec: none. Each device
   sees the change at its next list read (drawer open / pull). No new update
   kind.*
7. **Duplicate titles on rename.** *Rec: allowed, no uniqueness check
   (sessions are addressed by id).*
8. **Order inside Pinned.** *Rec: same as the list (`updatedAt` desc). No
   manual reordering.*

**Answers (orchestrator, 2026-11-17, owner asleep — night delegation; owner said "vai in autonomia" for this task):** Q1–Q8 all as recommended. The owner may overrule on waking.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Execution

*— claude-opus-5-5, 2026-11-17 (executor, slice S1 only)*

**S1 — DONE.** S2 and S3 not started.

**Load-bearing check (re-run first): holds.** Every cited site is as described:
`autoAccept?`/`archivedAt?` in the sidecar (`daemon-state-file.ts`), written
only when set, and `parseSidecar` rebuilds the value from known fields only, so
an unknown optional field is ignored rather than refused. `setAutoAccept` →
`this.persist()` (`hosted-session.ts`). `rename` → `rewriteArchived`, which
rewrites only the state file when the record is not resident
(`session-host.ts`). `toSessionList` keys on `lastChangeAt`. Live and archived
summaries both pass through `SessionSummary`. The archive path is
`persistedState` → `toRecord`, so a pin captured there survives archiving.
The `serve` start path reads `loadState().meta` (archived) and
`load().record` (live) (`cli/src/serve.ts:884,900`), so both now carry the pin.

**As built (dependency order):**
1. Protocol: `session.ts` adds `MAX_PINNED_SESSIONS = 20`,
   `PinParamsSchema {sessionId, pinned: boolean}`, `PinResultSchema {pinned}`,
   entry `pinned: z.literal(true).optional()`, and result
   `pinned: SessionListEntry[] (max 20).optional()`. `methods.ts` adds
   `Method.Pin` and registers it in `RequestSchemas`. Additive, so there is no
   `protocol.d/` note. `protocol.json` was regenerated (`bun run schema:export`).
2. Persistence: `pinnedAt?` on `DaemonSessionState`, `DaemonSessionRecord`,
   `DaemonSidecar` and `ArchivedMeta`. It is written only when set
   (`sidecarOf`, `toRecord`). `parseSidecar` keeps it only if `isWireStamp`;
   anything else is dropped, never refused. It is carried by the loader and by
   `loadState`'s meta. No `DAEMON_STATE_VERSION` bump. No log entry.
3. `HostedSession`: `pinnedAt` field, restored from `RestoredSessionState`,
   carried in `persistedState` and `summary`. `setPinned(on)` is a set:
   it stamps `now()` only on a change and persists only on a change.
   It moves no `lastChangeAt` and emits nothing.
4. `session-list.ts`: `pinned: true` on the entry. On the first page only
   (no cursor), `pinned` holds every pinned summary, sorted with `compare`
   and sliced to the cap. `sessions` and `cursor` are untouched.
5. `SessionHost.pin(id, on)`: tombstone → `SessionDeleted`; then live or
   archived; else `UnknownSession`. The cap is counted over live + archived
   in the same synchronous call, and is skipped when the session is already
   pinned or the call unpins. An archived pin sets `entry.pinnedAt` +
   `entry.pinChanged`, then `void rewriteArchived`. Both `rewriteArchived`
   paths (resident record and loaded state file) and their "nothing
   changed" guards now account for the pin (`withPin` helper). A reopen
   restores with the ENTRY's pin. `restore` passes `record.pinnedAt` on
   (restart and reopen).
6. `Connection`: `case Method.Pin` → `host.pin` (host-level, no `open`).
7. Client: `RemoteClient.pinSession(id, pinned): Promise<boolean>`, shaped
   like `rename`: it rejects while down, and maps `MethodNotFound` to "this
   daemon is too old to pin sessions — update tentacle".
8. `changelog.d/mobile-session-actions.added.md` (the plan's bullet).

**Drift from Implementation (and why):**
- *Client "list mapping"*: no code. `sessionList` is a schema-validated
  pass-through, so `pinned` (entry and array) reaches callers through the
  schema alone. This is pinned by `packages/client/test/session-pin.test.ts`.
- *`restore` also carries the pin*: the plan named only the reopen site, but a
  `serve` restart goes through `restore(loaded.record)` too.
- *`ArchivedEntry.pinChanged`* is the plan's "mark it changed". It is
  sticky, like `renamed`, so every later rewrite of that entry keeps the pin.
- *`json-schema.test.ts`* gained `session/pin` fixtures. The drift gate
  requires one per method; the plan did not list it.
- *Docs pointer in `docs/feat/mobile-chrome.md`*: left for S2, because it is
  about the phone UI.
- *Changelog fragment*: it describes the finished phone feature (S2). On its
  own, S1 ships no user-visible change, so this branch must not be released
  before S2 lands.

**Red before green.** Before the implementation,
`daemon/test/session-list.test.ts` P1/P2 and both
`client/test/session-pin.test.ts` cases failed on their assertions.
`daemon/test/session-pin.test.ts` and `protocol/test/session-pin.test.ts`
failed at import (`MAX_PINNED_SESSIONS` / `PinParamsSchema` did not exist), so
their non-vacuity is shown by mutation instead (below).

**Mutation checks** (`.tentacle/tmp/mobile-session-actions/mutate.ts`: back
up, replace one exact site, run the narrow file, restore; `git diff --stat`
was unchanged afterwards):

```
M1 sidecarOf drops pinnedAt (the plan's named one): KILLED, 5 red, incl. "a restart keeps the pin (decoded from the files by the real decoders)"
M2 setPinned without persist: KILLED, 3 red
M3 loaded-path guard ignores pin: KILLED, 2 red
M4 resident path ignores pin: KILLED, 1 red
M5 persistedState drops pinnedAt: KILLED, 5 red (incl. "archiving a pinned session keeps the pin")
M6 reopen uses the record's pin: KILLED, 1 red
M7 loadState meta drops pinnedAt: KILLED, 1 red
M8 cap counts live only: KILLED, 1 red
M9 parse passes a malformed pin: KILLED, 1 red
M10 pinned array from the page only: KILLED, 1 red (P2)
M11 no case Method.Pin: KILLED, 1 red (wire test)
M12 restart restore drops pin: KILLED, 3 red
M13 pinned array on every page: KILLED, 1 red (P3)
M14 pins hoisted out of sessions: KILLED, 3 red (P1, P2, P4)
```

(A first M10 variant survived because it was not a faithful mutation:
`entries` holds every entry after the cursor, not the page. It was replaced by
the version above.)

**Tests added:** `packages/daemon/test/session-pin.test.ts` (15: live/archived/
resident/reopen/restart/archived-restart/no persister/errors/cap/sidecar
round-trip and malformed/wire), `daemon/test/session-list.test.ts` (+4, P1–P4),
`protocol/test/session-pin.test.ts` (4), `client/test/session-pin.test.ts` (2),
plus `json-schema.test.ts` fixtures.

**Gate:** `bun run typecheck` clean (root + mobile + relay) · `bun run lint`
clean (1840 files, 0 errors/warnings) · `bun test` 13390 pass / 5 skip / 0
fail. The 5 skips come from pre-existing opt-in `skipIf` sites (live
docker/k8s, slow keepalive). I did not match them name by name, but none of
the new test files contains a skip.

**Not verified:** a real `serve` restart on disk. It is covered only through
the spy store's real decoders and `loadState`. To verify, pin a session over
`connect`, restart `serve`, then run `session/list`.

## Review

*(empty)*
