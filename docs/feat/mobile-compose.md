# feat/mobile-compose — compose from the phone: steer, send now, queued/returned rows, offline outbox, photos (mobile task 13)

> **Status:** implementation (plan written, **not approved** — see Owner questions)
> **Branch:** umbrella `feat/mobile-compose` (this doc). Each sub-task runs on its own branch carved from its section below (the `mobile-session-view` precedent): `feat/mobile-compose-queue` (13a), `feat/mobile-outbox` (13b), `feat/mobile-photo-input` (13c), `feat/mobile-compose-screen` (13d).
> **Size:** L as a whole → split: 13a S–M · 13b M · 13c M · 13d M · **Blast:** 13a contained · 13b contained (app-only, but it is where "exactly once" and "never a blind send" live for the phone) · 13c **cross-module** (moves the image sniffer from `tui` to `core`) · 13d contained · **Suited:** DeepSeek executes each; fresh-context Opus Review per sub-task — 13b's red-teams exactly-once across drop / kill / daemon restart, 13c's the sniffer move (TUI unchanged) and the Step 0 results; 13d's Maestro run (iOS 26.5) is part of its gate (eval decision 20)
> **Changelog:** `changelog.d/mobile-compose.added.md`, written on 13d's branch (the first user-visible slice). 13a, 13b, 13c: none.

## Context

*— claude-opus-5-5, 2026-11-14*

Mobile task 13 (`docs/eval/mobile-app.md` decision 21 table, row 13: "Compose:
prompt, steer, send now, stop, approvals, offline outbox", M · cross-module),
plus the **owner requirement of 2026-11-13**: attach PHOTOS from the phone
(library + camera) through the existing chunked `attachment/put` upload
(`docs/feat/attachments-upload.md`, Owner Q2 (a): "`attachment/put` for worker,
`serve`, mobile"), shown in the transcript as task 12 shows images.

**What task 12 already covers (do not rebuild).** Task 12's Owner Q1 moved
"prompt while idle, Stop, approvals (incl. "No, let's talk about it")" into 12c
(`docs/feat/mobile-session-view.md:461-464`, 12c design `:248-280`). Left to 13
(`:21-25`, F12 `:356`): steer while a turn runs, "Send now", queued rows,
returned rows, the offline outbox. Also handed to 13 by earlier tasks:
- `tui-foreign-turns` QR2 (`docs/feat/tui-foreign-turns.md:789-795`, owner YES):
  **other writers' `returned` rows** are shown and reclaimed only on the phone,
  by an explicit act; task 5's F2 duplicate is solved (`queued-broadcast.md:1360-1367`:
  reclaim works on an archived session too, metadata-only).
- `connect-sessions` QN2 (`docs/eval/mobile-app.md:536-538`): **my returned rows
  after my process is gone** are not recognised (the client's `mine` map is
  in-memory, `client/src/remote-session.ts:167-171`).
- `queued-broadcast` (`:1286-1287`): "The mobile app does not subscribe yet
  (task 13): its rows stay *held*, never dropped."
- The writer rule (`docs/eval/send-now.md:538-552`, owner 2026-10-24): a queued
  message goes back to whoever wrote it, visibly — on the phone, **compose field
  + banner** — never re-sent by itself.

Owner decisions this task serves (eval): **15** writing while a turn runs =
exactly the TUI, same daemon methods, no mobile-only logic (steer = queued row
until injected; Send now only with a non-empty queue; ■ Stop; a rejected
enqueue puts the text back); **16** writing offline (enabled input, per-session
draft surviving a kill; offline send → "waiting for network" row; on reconnect
re-sync first, auto-send only if nothing changed, else Send / Queue as steer /
Discard; an in-flight command re-sent with its idempotency key, executed once);
**5** any device can steer a running turn; **10** camera permission asked only
when needed and explained; **13** native iOS UI, custom only transcript + input
bar; **20** pure modules under `bun test` + Maestro on the simulator before
merge. Mockups approved 2026-11-01 ("writing while a turn runs", "offline
outbox").

**State of the dependency.** 12a and 12b are merged (`apps/mobile/src/foreground-gate.ts`,
`session-controller.ts`, `transcript.ts`, `thumbnails.ts` on `main`); **12c is
not executed yet** (branch `feat/mobile-session-view-12c` has no commit past
`ba8c5a8`; `apps/mobile/src/screens/SessionScreen.tsx` is still 11a's
placeholder). This plan builds on 12c's *planned* `composer.ts`,
`session-view.ts`, `SessionScreen.tsx` and testIDs (`mobile-session-view.md:250-288`).
13a/13b/13c add only new files and can start before 12c lands; **13d starts
only after 12c is merged** and re-checks every 12c reference first (Step 0 of 13d).

**Repro (2026-11-14, this worktree) — the capability is missing.** Bash was
unavailable (the temp volume was full, ENOSPC), so this ran as the equivalent
ripgrep through the editor's search over `apps/mobile` (excluding
`node_modules`); the executor re-runs it with `rg` on current `main`:

```
$ rg -n "enqueue|sendNow|onReturned|onQueued|attachImage|sha256Bytes|image-picker|outbox" apps/mobile --glob '!node_modules'
apps/mobile/e2e/mock-model.ts:85:      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
```

(the one hit is a `ReadableStream` controller, not the session API.)

**Repro 2 (by reading; Step 0 of 13c proves it on Hermes) — an upload from the
app would throw today.** The app builds its client with no `sha256Bytes`
(`apps/mobile/src/connection.ts:135-142`); the default is `bunSha256Bytes()`
(`packages/client/src/remote-client.ts:821`), which returns `undefined` when
`globalThis.Bun` is absent (`:477-492`) — always, under Hermes. Then
`attachImage` throws "attachImage needs a binary sha-256 hasher" before any
frame (`remote-client.ts` `attachImage`, the `hasher === undefined` branch).

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

**Every compose action the phone takes is made exactly-once by a key the phone
mints ONCE, at compose time, and persists before the first attempt — so the
outbox may retry after a drop, an app kill or a daemon restart with no
duplicate, using only existing `RemoteSession` / `RemoteClient` methods (no
protocol change, AGENTS §7 "one session path").**

Proved against the source:
- **Prompt — `turnId` is a lifetime, persisted ledger key.** `HostedSession`
  keeps "Every turn this session accepted, by client `turnId`, for its lifetime
  (retries)" (`packages/daemon/src/hosted-session.ts:455-456`); `prompt()`
  checks the key FIRST and answers a known one with `{turnId, ended?}` without
  running anything (`:1993-1996`); a rejected prompt "starts and records
  nothing" (`:1997`), so a later retry with the same key is still free to run.
  The ledger is written to the `serve` record and restored on reload
  (`:634-636`, `restored?.turns`; `persistedState` `:1245-1248`). The client
  lets the caller mint the key (`RemoteSession.send(prompt, signal, {turnId,
  attachments})`, `client/src/remote-session.ts:985-1000`) and an ack carrying
  `ended` just finishes the turn (`:1258-1261`) — a resend of a turn that
  already ran shows nothing twice.
- **Steer — `enqueue` id, checked before the running check, persisted.**
  "a retry of an accepted id is a no-op success even after its turn ended
  (never `NoTurnRunning`, never injected twice). A rejected attempt is not
  recorded" (`hosted-session.ts:2694-2703`); ids restored on reload
  (`:637-640`, `enqueueIds`). It binds to the exact turn (`:2715-2721`), so a
  retry can never steer a LATER turn. The client takes the caller's key
  (`RemoteSession.enqueue(text, id)`, `remote-session.ts:958-975`).
- **Send now — the new turn's `turnId` is its idempotency key**
  (`packages/protocol/src/session.ts` send_now comment, "a retry acks it, like
  `session/prompt`"); a refusal names in `error.data.held` which texts the daemon
  holds anyway (`SendNowRefusalSchema`), so the caller restores exactly the rest.
- **Photo — content-addressed and resumable.** The blob key is the sha256 of
  the phone's own bytes; every `put` answer carries `have`; a probe (`data: ""`)
  resumes after a drop and dedupes a re-upload of complete bytes
  (`packages/protocol/src/attachment-upload.ts:1-20,31-53`;
  `RemoteClient.upload`, `remote-client.ts:1553-1640`). A partial stays in the
  session's store (evicted only when space is needed, ≥ 10 min stalled —
  `attachments-upload.md:660`, Q3 (a)).

So the outbox never needs a daemon change: its only job is to mint the keys
once, persist them, and decide WHEN a retry is allowed (decision 16's
"unchanged" rule) — a pure decision.

### Preconditions

- **P1 — the queue is broadcast in full** to every attached client (`queued`
  display update; `QueueState{entries, returned}`; "always FULL … a client
  converges after any loss", `protocol/src/session.ts:473-517`); the client
  keeps it per session (`RemoteSession.queued` / `onQueued`,
  `remote-session.ts:505-545`). A row is `{id, text}`; "mine" = an id my
  client sent; no device label.
- **P2 — returned rows wait for their writer**: they leave `returned` only by
  `session/reclaim` or a send-now that carries them; no expiry
  (`session.ts:483-488`). `reclaim` is public on the client
  (`RemoteClient.reclaim`, `remote-client.ts:1190`), accepted on an archived
  session too, metadata-only (`queued-broadcast.md:1076-1090,1360-1367`), and
  allowed "on a person's explicit act" for ids the client did not send
  (`session.ts:1156-1161`).
- **P3 — `RemoteSession.onReturned` hands back only the ids THIS process
  sent** (`remote-session.ts:674-739`, `mine` in memory, `:167-171`); the pure
  `handBack` (`client/src/hand-back.ts:30-57`) is not exported from
  `@tentacle/client` (`client/src/index.ts:7-21`). Hence D3 below: the app
  does its own hand-back over a PERSISTED id set and never registers
  `onReturned` (two mechanisms would hand a row back twice).
- **P4 — steers and send-now are text-only**: `EnqueueParams` / `SendNowMessage`
  carry `{id, text}` (`session.ts:1079-1126`); attachments-prompt decision 9
  (`docs/feat/attachments-prompt.md:445-446`) and the TUI refuses to enqueue
  with image chips, keeping text + chips (`docs/feat/attachments-tui.md:314`).
  Photos go only with a prompt (Owner question 2).
- **P5 — image limits are protocol constants**: `IMAGE_MIME_TYPES` png / jpeg /
  gif / webp (`protocol/src/attachment.ts:25`), `MAX_ATTACHMENTS_PER_MESSAGE` 5
  (`:29`), `MAX_IMAGE_BYTES` 15 MiB (`:37`), `ATTACHMENT_NAME_RE` (`:46`). HEIC
  is not accepted by any entry point; the TUI recognises and refuses it with a
  remedy (`packages/tui/src/image-sniff.ts:19-40`, `attachments-tui-detect.md:40,143-144`).
- **P6 — `RemoteSession.attachImage`** opens the session if needed, checks mode
  / size / ref with zero frames, then uploads (`remote-session.ts:410-460`;
  `RemoteClient.attachImage`). Typed refusals: `ImagesUnavailableError` (off),
  `RangeError` (size), `AttachmentsUnsupportedError` (old daemon,
  `remote-client.ts:149-163`), `AttachmentRefused{reason}`
  (`attachment-upload.ts` `AttachmentRefusedReason`), `UploadLinkLostError`
  after `UPLOAD_RECONNECT_MS` = 30 s with no link (`client/src/constants.ts:20`).
- **P7 — `@noble/hashes` 2.4.0 is already in the bundle's graph**
  (`packages/transport/package.json:14`, the Noise channel); its `sha256` is
  synchronous pure JS — the shape `sha256Bytes: (bytes) => string` needs
  (`remote-client.ts:433`).
- **P8 — the foreground gate drops the link on background** (12a,
  `apps/mobile/src/foreground-gate.ts`): an upload in flight sees a drop, waits
  up to 30 s, then rejects `UploadLinkLostError` (P6) — the outbox keeps the
  item and resumes on the next `up` (the probe reads `have`).
- **P9 — Maestro sees testIDs only** (no text on RN new architecture), E2E on
  **iOS 26.5** only (`mobile-session-view.md:170-174`). The simulator has **no
  camera**; its photo library is seeded with `xcrun simctl addmedia`.
- **P10 — the app has no on-disk storage yet** (no `expo-file-system` /
  AsyncStorage / SecureStore import in `apps/mobile/src`): the outbox store is
  the app's first. AGENTS §7's persistence rules govern SESSION logs, not this;
  the outbox borrows their discipline anyway (versioned header, atomic write,
  an unknown version refused and left untouched, never half-loaded).
- **P11 — no protocol change**: enqueue, send_now, reclaim, queued, prompt with
  image refs, attachment/put all exist. No `protocol.d/` note.

### Design

Shape (AGENTS §7 "logic lives in pure modules"): every decision in a React-free
module under `apps/mobile/src/`; screens map a view-model to elements.

**D1 — The composer's one action (13d, extends 12c's `composer.ts`).** From
(link, turn running?, field text, photo chips, own queued rows):

| link | turn | field | photos | primary button | secondary |
|---|---|---|---|---|---|
| up | idle | text and/or photos | ready | **Send** → `send(text, {turnId, attachments})` | — |
| up | running (own or foreign) | text | none | **Queue** (steer) → `enqueue(text, id)` | **Send now** iff own queue non-empty or field non-empty (TUI semantics) |
| up | running | empty | none | **■ Stop** (12c) | Send now iff own queue non-empty |
| up | running | any | ≥ 1 | Queue **disabled**, notice "photos go with the next prompt" (P4, Owner Q2) | Stop |
| down | any | text/photos | any | **Send later** → outbox item `waiting` | — |
| any | any | photos uploading | — | Send shows progress; the item is created at once and goes out when its uploads complete | — |

The composer clears the field and creates the outbox item in ONE synchronous
step on tap (a double tap finds an empty field: never two items). Send-now
semantics (which rows, joined how) mirror the TUI's `takeForSendNow` / `takeAll`
(`packages/tui/src/queued.ts:72,208`); the executor reads the TUI's key handling
for Ctrl+X Ctrl+S first and mirrors it, pinned by the parity test.

**D2 — Queue rows (13a, `compose-queue.ts`, pure).** Shown above the input:
the daemon's `entries` (every writer's waiting rows, in delivery order) merged
with my local rows not yet acked (the TUI's `shownRows` rule,
`queued.ts:94`); mine marked (id ∈ my persisted set), others labelled "from
another device". A row leaves on the next `queued` (delivered → it is in the
transcript as the `steer`), on a send-now, or into `returned`.

**D3 — Returned rows (13a).** One mechanism, keyed by the PERSISTED own-id set
(13b store), over `onQueued` + `RemoteClient.reclaim` — never `onReturned` (P3):
- **mine** (id ∈ persisted set — enqueues and send-now messages of this
  process OR of a killed earlier one): given back once into the compose field
  (joined like the TUI) + banner `returned-<cause>` ("Turn stopped from another
  device: your 2 queued messages are back"), then reclaimed; a reclaim that
  fails is retried at the next state still listing them, never a second
  hand-back (the client's own rule, `remote-session.ts:724-737`). Ids carried
  by my live send-now are skipped (`carried`, as `hand-back.ts`); ids I already
  restored after a send-now refusal are only reclaimed (`handedBack`).
- **others'** (QR2): a row "returned to another device" with **Take**: one tap
  = reclaim + text into the field. Never automatic (P2: no device can tell it
  is the writer). A Take whose reclaim fails keeps the text in the field and
  the row (the next state decides).
Logic mirrors `client/src/hand-back.ts`, pinned by a parity test (test-only
deep import), as 12b did for the transcript fold.

**D4 — Drafts and the outbox (13b, `outbox.ts` + `drafts.ts` pure,
`outbox-store.ts` over an injected `OutboxFs` port, `outbox-driver.ts` over an
injected session port).**
- A **draft** = per `(computerId, sessionId)` field text + photo chips, saved
  debounced (pure policy, injected clock) and on background; restored on open.
- An **item** = `{itemId, computerId, sessionId, kind: prompt|steer, text,
  photos: [{file, ref}], turnId (prompt key), enqueueId (steer key), steerTurnId
  (the turn a steer was typed for), basis, state}` — keys minted ONCE at
  creation and written to disk BEFORE the first attempt (load-bearing
  assumption). `basis` = what the user saw: history length, last turn id, turn
  running?, compaction epoch.
- States: `waiting` (offline) → `uploading` → `sending` → `sent` (deleted, its
  photo copies deleted) | `needs-decision` | `back-to-draft`.
- **`decide(item, facts)`** after re-sync (`open()` done, history + queue +
  running turn known):
  - a running turn whose id === `item.turnId` → it is mine and already accepted
    → `sent` (render as own; no resend);
  - prompt, session idle, facts == basis → resend with the SAME `turnId`
    (auto); facts ≠ basis → `needs-decision` (sheet: what changed + **Send**
    (same key — exactly once even if it did run) / **Queue as steer** (only if
    a turn runs; new `enqueueId`) / **Discard** / **Edit**);
  - steer, running turn === `steerTurnId` → resend with the same `enqueueId`
    (auto; a no-op if it landed); any other state → `needs-decision`;
  - session archived / deleted / gone → `back-to-draft` + banner; never a
    reopen by the outbox (2a rule: only an explicit Reopen revives);
  - a refusal: `TurnInProgress` (a foreign turn started first) → the text back
    in the field, never converted to a steer by itself (12c F13);
    `NoTurnRunning` on a steer → `needs-decision`.
- Photos in an item are COPIES in the app's sandbox (the user may delete the
  original); each ref is built from the copy's bytes (sha256 via P7). Uploads
  run one photo at a time (≤ 15 MiB of bytes in JS memory at once). A
  `not_uploaded` refusal at prompt time (the partial was evicted) → one
  re-upload, then refuse visibly.
- **Store:** one JSON file per computer (`{schemaVersion: 1, items, drafts,
  ownIds}`) + `outbox/<itemId>/<n>.<ext>` copies under Application Support,
  excluded from iCloud backup, iOS default data protection (Owner Q7). Write =
  tmp file + rename; an unknown `schemaVersion` is refused and the file left
  untouched; an unparsable file is set aside (`.corrupt-<ts>`), never deleted;
  a failed write keeps the state in memory and shows banner `not-saved`.
- `ownIds` (D3) gains an id when its enqueue / send-now is created and loses it
  when the daemon no longer lists it in `entries` or `returned` (after the
  reclaim's next state) — bounded by the session's live queue.

**D5 — Photos (13c).**
- **Source** (`photo-source.ts`, a thin adapter, no branching): Library =
  `expo-image-picker` `launchImageLibraryAsync` (PHPicker: no library
  permission prompt), multi-select ≤ 5 − chips; Camera = `launchCameraAsync`,
  asks camera permission at first use with `NSCameraUsageDescription` (decision
  10). Bytes read with `expo-file-system` `File.bytes()`; copied into the
  outbox folder.
- **Decision** (`photo-input.ts`, pure): the type comes from the BYTES
  (`sniffImageType`, moved to `@tentacle/core` — D6), never from the picker's
  mime or extension; `heic` → **convert to JPEG** (Owner Q3) by the adapter,
  then re-sniffed; a result over `MAX_IMAGE_BYTES` → one downscale step to fit
  (Owner Q3) or refusal `too-large`; > 5 → `too-many`; empty → `empty`; a GIF
  over the cap → refused (not re-encoded: it would lose animation); the name
  sanitised to `ATTACHMENT_NAME_RE` and ≤ 255 chars (a C1 char would refuse the
  WHOLE message, `attachment.ts:41-46`).
- **Hash:** `hash.ts` = noble `sha256` → lowercase hex, passed as
  `sha256Bytes` in `connection.ts` (fixes Repro 2).
- **Upload timing:** at pick when the link is up (chip shows progress), else
  at send / reconnect (Owner Q4). A removed chip's blob stays in the daemon
  store until session end (counted in the 100 MiB/session cap,
  `attachments-upload.md:660`).
- **In the transcript:** as 12b/12c — `[image: name]` on the user row (the refs
  ride `UserRow.images`); real thumbnails need `attachment/get`, which does not
  exist (`mobile-session-view.md:597-617`) — Owner Q1.

**D6 — One sniffer (13c).** `packages/tui/src/image-sniff.ts` moves to
`packages/core/src/image-sniff.ts` (it imports only a `@tentacle/core` type,
`:11`); the TUI file becomes a one-line re-export so no TUI import changes
(the TUI is being reworked by `app-decomposition`: touching its call sites
would conflict). Its tests move with it; the TUI's existing tests stay green
unchanged — that is the proof.

### Sub-tasks, files, order

13a, 13b, 13c touch **disjoint** files (only new app modules; 13c alone owns
`package.json` / `bun.lock` / `app.json` / `connection.ts` / `core` / `tui`)
→ they may run in parallel (Owner Q8). **13d** needs all three AND 12c merged.

**13a `mobile-compose-queue` — S–M · contained**

| File | Change |
|---|---|
| `apps/mobile/src/compose-queue.ts` (new) | pure: shown rows (D2), hand-back (D3), send-now take/restore |
| `apps/mobile/test/compose-queue.test.ts`, `compose-queue-parity.test.ts` (new) | pure; parity vs `packages/tui/src/queued.ts` and `packages/client/src/hand-back.ts` (test-only imports) |

**13b `mobile-outbox` — M · contained**

| File | Change |
|---|---|
| `apps/mobile/src/outbox.ts`, `drafts.ts` (new) | pure: item model, `decide`, transitions, draft debounce |
| `apps/mobile/src/outbox-store.ts` (new) | versioned JSON over an injected `OutboxFs` port (no expo import) |
| `apps/mobile/src/outbox-driver.ts` (new) | per session: runs `decide` on `up`+open, calls `attachImage` / `send` / `enqueue` / `sendNow` through an injected port |
| `apps/mobile/test/outbox.test.ts`, `drafts.test.ts`, `outbox-store.test.ts` (new) | pure, in-memory fake fs incl. crash between tmp and rename |
| `apps/mobile/test/outbox-link.test.ts` (new) | in-process `SessionHost` + `Connection`, real `RemoteClient`s (the `session-link.test.ts` pattern) |

**13c `mobile-photo-input` — M · cross-module**

| File | Change |
|---|---|
| `packages/core/src/image-sniff.ts` (moved), `packages/core/src/index.ts` (export) | the sniffer, unchanged |
| `packages/tui/src/image-sniff.ts` | one-line re-export from `@tentacle/core` |
| `packages/core/test/image-sniff.test.ts` (moved from `packages/tui/test/`) | unchanged cases |
| `apps/mobile/src/photo-input.ts`, `hash.ts` (new) | pure |
| `apps/mobile/src/photo-source.ts` (new) | adapter: picker, camera, file bytes, JPEG convert / downscale |
| `apps/mobile/src/connection.ts` | `sha256Bytes: sha256Hex` in the client options |
| `apps/mobile/package.json`, `bun.lock` | exact pins, `apps/mobile` only: `expo-image-picker`, `expo-image-manipulator`, `expo-file-system` (SDK 58 line), `@noble/hashes` 2.4.0 (= transport's) |
| `apps/mobile/app.json` | `NSCameraUsageDescription` (+ the picker plugin's config) |
| `apps/mobile/test/photo-input.test.ts`, `hash.test.ts` (new); `connection.test.ts` | pure + hasher wired |

**13c Step 0 (blocking, before any other 13c code; two-strike rule):** a
one-off probe screen in a Release build on the iOS 26.5 simulator, Maestro
asserting testIDs: (1) `simctl addmedia` a HEIC and a PNG; the picker returns
them and Maestro can drive PHPicker (if not: a `__DEV__`-only fixture source
behind the `photo-source` port for E2E — named in Execution, not chosen
silently); (2) HEIC → JPEG conversion sniffs as `image/jpeg`; (3) a 48 MP-class
HEIC fixture's JPEG size vs 15 MiB; (4) time to `File.bytes()` + noble sha256 of
15 MiB under Hermes (if > 3 s: report — fallback is expo-crypto's native digest
computed beforehand, which needs a client seam: STOP and ask); (5) one 15 MiB
`attachImage` to the e2e `serve`: wall time and peak memory. Results pasted in
Execution.

**13d `mobile-compose-screen` — M · contained** (after 12c + 13a/b/c)

| File | Change |
|---|---|
| `apps/mobile/src/composer.ts` (12c's) | D1 truth table |
| `apps/mobile/src/session-view.ts` (12c's) | queued / returned / outbox rows, banners `returned-*`, `waiting-network`, `not-saved` |
| `apps/mobile/src/outbox-fs-expo.ts` (new) | `OutboxFs` over `expo-file-system` (backup-excluded dir) |
| `apps/mobile/src/screens/SessionScreen.tsx`, `screens/compose/*.tsx` (new) | input bar: photo button (native action sheet Library / Camera), chips with progress / refusal, queued rows, Send now, Take, outbox decision sheet (native page sheet) |
| `apps/mobile/App.tsx` | wiring: store per computer, driver per open session, drafts on `AppState` |
| `apps/mobile/e2e/mock-model.ts`, `hooks.ts`, `run.ts`, `seed.ts` | mock replies `saw N images` to image content; hooks `queue-state`, `laptop-enqueue`, `laptop-cancel`, `laptop-detach`, `history` (+ attachments per message); `simctl addmedia` fixtures |
| `apps/mobile/e2e/flows/12…19-*.yaml` | below |
| `apps/mobile/test/composer.test.ts`, `session-view.test.ts`, `e2e-flows.test.ts` | extended |
| `changelog.d/mobile-compose.added.md` | the fragment |

**13d Step 0:** re-read 12c as merged; every 12c name this plan uses
(`composer.ts`, `session-view.ts`, testIDs, the 12c e2e hooks) is checked; a
mismatch → fix this doc first (AGENTS §8), then code.

New testIDs: `composer-queue`, `composer-send-now`, `composer-send-later`,
`composer-photo`, `photo-library`, `photo-camera`, `chip-<n>-<state>`
(`uploading|ready|refused-<reason>`), `queued-row-<id>-<mine|other>`,
`returned-banner`, `returned-other-<id>`, `take-<id>`, `outbox-row-<itemId>-<state>`,
`outbox-decision`, `outbox-send|steer|discard|edit`, `composer-filled`
(Maestro cannot read the field's text, P9).

### Failure modes

| # | Case | Behaviour | Convergence |
|---|---|---|---|
| F1 | **Offline send** | item `waiting`, row with its own icon, on disk | on `up` + re-sync: `decide` (D4) |
| F2 | **Link drops between send and ack** | client resends the same key (existing path) | daemon ledger: executed once |
| F3 | **App killed between send and ack** | item on disk in `sending` with its key | relaunch → `decide`: running turn === key → `sent`; idle & unchanged → resend same key (no-op if it ran); changed → sheet, Send still uses the key |
| F4 | **Duplicate send** (double tap, retry after kill, Send in the sheet after it did run) | one item per tap (field cleared synchronously); every retry reuses the key | daemon ledger / `enqueued` set: once |
| F5 | **App killed mid-upload** | partial stays daemon-side (`have`); the copy + id stay in the item | relaunch → probe → only missing chunks resent; then the prompt |
| F6 | **Backgrounded mid-upload** (gate drops the link, P8) | upload rejects `UploadLinkLostError` after 30 s; item stays `uploading` | next `up` → probe → resume. No iOS background upload (debt) |
| F7 | **Foreign turn starts before my prompt lands** | `TurnInProgress` → text + photos back in the field + notice | the foreign turn renders; my next tap is a steer (text) — never auto-converted |
| F8 | **Steer typed during a foreign turn** | allowed (decision 5): `enqueue` binds to the running turn | row shows as mine on every device |
| F9 | Steer retried after its turn ended | daemon `NoTurnRunning` (the id was never accepted) → `needs-decision`; accepted earlier → no-op | never steers a later turn (`hosted-session.ts:2715-2721`) |
| F10 | **Turn stopped elsewhere** with my rows queued | `returned` → field + banner, reclaimed once | also after my app was killed (persisted ids) |
| F11 | Others' rows returned (writer gone) | `returned-other` row + Take | explicit only; never auto-claimed |
| F12 | Send now refused (`TurnInProgress` / `CompactInProgress`) | texts not in `held` back to the field; held ones only reclaimed later | as the TUI (`afterRefusal`) |
| F13 | **Photo over 15 MiB** | refused before any frame (`RangeError` / pure check) unless Owner Q3 downscale fits it | chip `refused-too_large` with the size |
| F14 | **HEIC from the iPhone camera / library** | converted to JPEG on the phone, re-sniffed; never sent as HEIC | Step 0 proves the conversion |
| F15 | More than 5 photos | picker limited to 5 − chips; extra refused `too-many` | — |
| F16 | Photo while a turn runs | Queue disabled with notice (P4); photos stay as chips | sent with the next prompt |
| F17 | Daemon cannot take images (`images_off`, old daemon `AttachmentsUnsupportedError`, `store_full`) | chip refused with the reason; text kept; nothing sent | user removes the photo or waits |
| F18 | Partial evicted before the prompt (`not_uploaded`) | one re-upload, then refuse visibly | — |
| F19 | **Daemon restart** mid-turn with my steer queued | ids persisted daemon-side (`enqueueIds`); the cut turn closes → `returned` | F10 |
| F20 | Session archived / deleted / gone while an item waits | `back-to-draft` + banner; no reopen | explicit Reopen only |
| F21 | Outbox file: write fails / unknown version / corrupt | memory + banner `not-saved` / refused, untouched / set aside | never half-loaded, never silently dropped |
| F22 | Phone storage full when copying a photo | chip refused `no-space`; nothing half-written | — |
| F23 | Picker / camera permission denied | native explanation; camera button explains how to enable it in Settings | — |
| F24 | Two of my devices (phone + iPad) | ids are per-install UUIDs; each recognises only its own rows | the other's rows show as "another device" |

### §7 invariants this task leans on

- **One session path:** only `RemoteSession` / `RemoteClient` methods; no frame
  built by the app; no `packages/client` change.
- **Single broker:** untouched (12a's); the outbox never answers an ask.
- **Protocol:** untouched (P11). `@tentacle/core` gains an export (D6) — no wire
  or persistence change.
- **"A queued message goes back to its writer, never re-sent by itself"**
  (owner rule): D3 + D4 never resend a returned row nor convert a refused prompt.

### Tests (red first; each names its mutation)

13a — `compose-queue.test.ts`: local row before ack, acked by the daemon's
list, others' rows labelled; mine returned → given once + reclaimed once
(**mutation:** drop `handedBack` → given twice → red); carried by my send-now →
not given; others' returned → listed, never auto-reclaimed (**mutation:**
auto-reclaim → red); Take → reclaim + text. `compose-queue-parity.test.ts`:
same fixtures through `tui/src/queued.ts` (`shownRows`, `takeForSendNow`,
`afterRefusal`) and `client/src/hand-back.ts` → same results.

13b — `outbox.test.ts`: the `decide` truth table (every row of D4); keys minted
once (**mutation:** mint per attempt → `outbox-link` T1 red); refusal mapping.
`outbox-store.test.ts`: round trip; crash between tmp and rename → old file
intact; unknown version → refused, file bytes unchanged; corrupt → set aside.
`outbox-link.test.ts` (real daemon, two clients, the second built AFTER the
first is destroyed = an app kill):
- T1 prompt written, ack dropped (frame spy swallows it), client destroyed;
  new client + same item → ONE user message in `snapshot` (**mutation:** fresh
  `turnId` on resend → two → red).
- T2 steer accepted, client destroyed, same turn still running → resend → one
  steer injected; T3 turn ended meanwhile → `NoTurnRunning` → `needs-decision`.
- T4 offline compose, the laptop runs a turn meanwhile → `needs-decision`, zero
  `session/prompt` frames (**mutation:** ignore `basis` → auto-sent → red).
- T5 upload cut after chunk 2 + client destroyed → new client: first `put` is a
  probe, bytes sent < size + 3 chunks, prompt names the ref once.
- T6 session archived / deleted meanwhile → `back-to-draft`, no `open{reopen}`
  frame (**mutation:** reopen → red).
- T7 laptop's turn starts first → `TurnInProgress` → text back, no `enqueue`.
- T8 my steer queued, client destroyed, laptop cancels → new client (persisted
  `ownIds`) gives it back once and reclaims (**mutation:** in-memory ids → not
  given → red).

13c — `photo-input.test.ts`: type from bytes (**mutation:** trust the picker's
mime → a HEIC named `.jpg` passes → red); HEIC → convert; over cap → downscale
or refuse per Q3; > 5; empty; GIF over cap refused; C1 char in name sanitised
(**mutation:** a `\u0000-\u001f` filter only → red). `hash.test.ts`: noble hex
== `Bun.CryptoHasher` on lengths 0/1/64/1 MiB+1. `connection.test.ts`: the
client is built with a `sha256Bytes` that is not Bun's (**mutation:** remove
it → red). Moved sniffer tests green in `core`; TUI suite unchanged and green.

13d — `composer.test.ts` (D1 table incl. foreign turn, photos while running,
link down, double tap → one item); `session-view.test.ts` (rows + banners);
`e2e-flows.test.ts`: every new flow ends on a daemon-truth hook or a row id.

**Maestro (`bun run e2e:mobile --ios 26`, iOS 26.5; mandatory before 13d's merge):**
- `12-steer` — own `HOLD` turn; type → `composer-queue` → `queued-row-*-mine`;
  `release-hold` → row gone; hook `history`: the steer inside that turn.
- `13-send-now` — `HOLD`; two steers; `composer-send-now` → hook: old turn
  cancelled, new turn's prompt = both texts joined.
- `14-returned-mine` — `HOLD`; queue a steer; hook `laptop-cancel` →
  `returned-banner`, `composer-filled`; hook `queue-state`: `returned` empty.
  Variant: `stopApp` before the cancel, `launchApp` after → same (persisted ids).
- `15-returned-other` — hook `laptop-enqueue` + `laptop-detach` +
  `laptop-cancel` → `returned-other-<id>`; tap `take-<id>` → `composer-filled`;
  hook: `returned` empty.
- `16-offline-outbox` — hook `stop-serve`; type, send → `outbox-row-*-waiting`;
  `stopApp`/`launchApp` → still there; `start-serve` → row gone; hook `history`:
  the text exactly once.
- `17-outbox-changed` — offline compose; `start-serve` + hook `laptop-prompt`
  (ends) → `outbox-decision` → `outbox-send` → hook: the text once.
- `18-photos` — `addmedia` PNG + HEIC; `composer-photo` → `photo-library` →
  pick both (or the Step 0 fixture source) → `chip-*-ready` ×2; send → hook
  `history`: 2 refs, `image/png` + `image/jpeg`; mock reply `saw 2 images`.
- `19-photo-kill-mid-upload` — 14 MiB fixture; send; at `chip-0-uploading`
  `stopApp` → `launchApp` → hook `history`: the image once.
- Camera: no simulator camera (P9) → unit tests over the adapter port + a line
  on the real-iPhone checklist (camera permission prompt, a HEIC shot sent).

Red-before-green: flows 12–19 fail on 12c (no queue rows / photo button);
13b's T1/T4/T6/T8 and 13a's mutations are run red, then reverted.

### Owner questions

1. **Scope:** 13 = steer, Send now, queued + returned rows (mine and others'),
   drafts, offline outbox, photos; approvals and Stop stay 12c's (12 Q1);
   photos show as `[image: name]` like 12c, real thumbnails waiting for an
   additive `attachment/get` (a separate small task)? **Rec: yes.**
2. **Photo while a turn runs:** steers are text-only, so the phone does as the
   TUI — Queue disabled with "photos go with the next prompt", chips kept —
   and image steers become a later protocol task? **Rec: yes.**
3. **HEIC and size:** convert HEIC → JPEG on the phone (never sent as HEIC),
   and only when a photo is still over 15 MiB downscale it once to fit (chip
   says "resized"), instead of refusing it? **Rec: yes** (a phone user cannot
   convert by hand; the TUI's "no resize" stays for the laptop).
4. **Upload timing:** upload as soon as a photo is picked (progress on the
   chip, Send is instant), accepting that a removed photo stays in the
   daemon's store until the session ends? **Rec: yes.**
5. **Outbox rule:** auto-send only if nothing changed since the user wrote it
   (same history length, same last turn, nothing running, no compaction);
   otherwise the sheet Send / Queue as steer / Discard / Edit, and Send always
   reuses the original key (no duplicate even if it did go out)? **Rec: yes.**
6. **Returned rows:** mine come back by themselves into the field + banner
   (even after an app kill, ids kept on the phone); other devices' rows show as
   "returned to another device" with an explicit **Take**? **Rec: yes.**
7. **Storage on the phone:** drafts, outbox and photo copies (up to 5 × 15 MiB
   per message, deleted once sent) in Application Support, excluded from
   iCloud backup, default iOS data protection? **Rec: yes.**
8. **Parallelism:** run 13a, 13b, 13c at the same time (disjoint files, three
   worktrees — one over the 2-task rule), then 13d after 12c and all three
   merge? **Rec: yes**; if not, 13c + 13a first (13c's Step 0 is the riskiest), then 13b.

### Notes / debt

- Thumbnails of images in the transcript: need `attachment/get` (12b Drift 1).
- No iOS background upload (`URLSession` background transfer needs native code):
  an upload pauses when the app leaves the foreground and resumes on return.
- Image steers / image send-now: a protocol change (P4), later.
- Audio/video attachments: `eval/attachments-audio-video` (TODO.md:486).
- Binary frames for uploads (base64 +33 %): `eval/binary-frames` (TODO.md:487).
- iOS 18 Maestro leg unverified (P9), as in 11a/12.

## Execution

### 13a `mobile-compose-queue` — DONE (contained)

*— deepseek-v4.1-flash-1017 (executor of slice 13a), 2026-11-14*

**Load-bearing check, re-run first (it PASSED — precondition, not the whole
plan's assumption).** Slice 13a rests on P1/P2/P3 only; 13b/13c own the
key-persistence and the hasher. In
`.tentacle/tmp/mobile-compose-13a/load-bearing.txt`:

```
== P1 QueueStateSchema / onQueued / queued getter ==
packages/protocol/src/session.ts:514:export const QueueStateSchema = z.object({
packages/client/src/remote-session.ts:511:  get queued(): QueueState | undefined {
packages/client/src/remote-session.ts:537:  onQueued(listener: (state: QueueState) => void): () => void {
== P2 reclaim public ==
packages/client/src/remote-client.ts:1190:  reclaim(sessionId: string, ids: readonly string[]): Promise<void> {
== P3 hand-back NOT exported from the client index ==
no hand-back export (as P3 says)
== parity references exist ==
packages/tui/src/queued.ts:72: takeForSendNow · :94 shownRows · :127 afterRefusal · :164 returnedNotice
packages/client/src/hand-back.ts:30: handBack
== 13a module absent (feat: capability missing) ==
ls: apps/mobile/src/compose-queue.ts: No such file or directory
```

The plan's Context **Repro** also re-ran on this branch: the only hit for
`enqueue|sendNow|onReturned|onQueued|attachImage|sha256Bytes|image-picker|outbox`
under `apps/mobile` is `apps/mobile/e2e/mock-model.ts:85`, a `ReadableStream`
controller — the capability is missing, as recorded.

**As built, in order.**

1. `apps/mobile/src/compose-queue.ts` (new, pure, React-free; 381 lines): D2
   `shownRows` + `addRow` / `markAcked` / `onReject` / `takeForSendNow` /
   `handOff` / `afterRefusal` / `restoredByRefusal`; D3 `planHandBack` /
   `handBackStep` / `settleReclaim` / `returnedNotice` / `returnedOthers` /
   `takeReturned`; D4's bound `settleOwn`. Types `OwnIds` (the persisted
   id → my-text map 13b stores), `ShownRow` (the daemon's row plus `mine`),
   `ReturnedRow`, `HandBackStep`, `TakePlan`.
2. `apps/mobile/test/compose-queue.test.ts` (new, 21 tests) — red first, on the
   module being absent, then on the assertion that mattered (`acked` leaked
   into the shown row, see Drift 3).
3. `apps/mobile/test/compose-queue-parity.test.ts` (new, 34 tests) — the same
   fixtures through `packages/tui/src/queued.ts` (`shownRows`, `takeForSendNow`,
   `afterRefusal`, `returnedNotice`) and `packages/client/src/hand-back.ts`
   (`handBack`), test-only relative imports (the 12b `transcript-parity`
   pattern); the app's `planHandBack` must return the client's exact
   `{give, reclaim}` arrays.
4. `changelog.d/mobile-compose-13a.added.md` (see Drift 2).
5. Gates: see **Gate** below.

**Gate.**

```
bunx tsc --noEmit                                   clean (exit 0)
bunx tsc -p apps/mobile                             clean (exit 0)
bun run lint                                        clean — 1067 files, 0 errors, 0 warnings
bun test apps/mobile/test/compose-queue*.test.ts    55 pass / 0 fail
bun test apps/mobile                                271 pass / 0 fail (24 files)
bun test packages/cli                               2736 pass / 0 fail (176 files)
```

The only lint trips on the new files were formatting + `useImportType`, fixed
with `biome check --write`; the baseline stays 0 errors / 0 warnings.

**Full `bun test`, honestly — not green, and not mine.** Three whole-suite runs
each ended `8331 pass · 3 skip · 1 fail`, with a **different** failing test each
time and every one of them in a package this slice does not touch (grep:
nothing outside `apps/mobile` imports `compose-queue`; `apps/mobile/package.json`,
`bun.lock`, `packages/core`, `packages/tui`, `packages/client` all unmodified):

| run | failing test | isolated |
|---|---|---|
| 1 | `packages/cli/test/engine-runtime.test.ts:1523` — "startAttachRuntime … never deletes": `saved` length 0, expected 1 | 104 pass |
| 2 | `packages/cli/test/local-runtime.test.ts:475` — "resumes a saved session …": `records[0]` null | 79 pass |
| 3 | `packages/exec/test/confinement.test.ts:474` — "R2-4: a hard-linked file INSIDE the root is writable again" | 46 pass |

Runs 1 and 2 are `await new Promise(r => setTimeout(r, 20))` → read-the-store
assertions; run 3 is a filesystem race. All three pass in isolation and per
package (`packages/cli`: 2736 pass, 0 fail; `apps/mobile`: 271 pass, 0 fail),
which is the same count and the same tests as `main` — nothing regressed, the
20 ms timings simply lose under this machine's load (**uptime load average
15–22**, 24 sibling `bun test` / Maestro processes from the parallel 13b/13c
slices at the time of each run). PER AGENTS §0 I stopped after the third run
rather than re-running the same experiment. The 3 skips are the three opt-in
ones §6 names (live-k8s, live-docker, the real-socket keepalive).
**To verify:** re-run `bun test` on an idle machine; on this branch it must
report `8334 pass · 3 skip · 0 fail`.


**Failure modes of the plan this slice owns.** F10 (mine returned → field +
banner, reclaimed once — also after a killed app, since `own` is the persisted
map: pinned by the "mine comes back once" + "the text is MINE" tests), F11
(another writer's returned row listed, never auto-reclaimed, only `take`),
F12 (send-now refusal: only the texts the daemon does not `held` come back;
`restoredByRefusal` names them so the hand-back does not give them twice), F24
(ids are per-install; a foreign row is never mine), plus the TUI's D2 rules (a
local row before its ack, an acked-and-drained row gone, my `sending` state
surviving the daemon's list, delivery order for every writer's rows). F1–F9,
F13–F23 belong to 13b/13c/13d.

**Failure-mode tests present and green** (`bun test apps/mobile/test/compose-queue*.test.ts`):
local-before-ack · acked-row-drained · others'-rows-labelled-and-ordered ·
sending-state-survives · take/second-take-empty · handOff-keeps-late-rows ·
refusal-restores-unheld · `restoredByRefusal` (held / no-report /
MethodNotFound / NoTurnRunning / null) · reject-notifies-unless-owned ·
mine-once (+ a lost reclaim retried at the next state) · text-is-mine ·
carried-not-given · two-joined-with-one-banner · foreign-never-reclaimed ·
Take + Take-on-mine-is-none + Take-on-absent-is-none · duplicate-id-once ·
banner-wording · `settleOwn` (forget / keep-in-flight / keep-returned) ·
34 parity cases.

**Mutations (the plan's own targets, plus five of mine; each run in place, then
reverted — `cmp` against the pre-mutation copy confirms the file is identical,
and the suite is green again: 55 pass / 0 fail):**

```
M1 drop `handedBack` (give a row twice):            exit=1  53 pass 2 fail
M2 auto-reclaim another writer's row w/ its text:   exit=1  52 pass 3 fail
M3 shown rows ignore `acked` (drained row stays):   exit=1  52 pass 3 fail
M4 a send-now take leaves the rows queued:          exit=1  50 pass 5 fail
M5 settleOwn forgets ids not yet in the daemon view: exit=1 54 pass 1 fail
M6 banner always blames another device:             exit=1  50 pass 5 fail
M7 Take accepts one of my own rows (2nd path):      exit=1  54 pass 1 fail
reverted
```

M1 and M2 are the plan's two named mutations ("drop `handedBack` → given
twice"; "auto-reclaim → red"); both are red **on the assertion**, not on a
compile error, and both are also caught by the parity file (the client's
`handBack` disagrees). Script: `.tentacle/tmp/mobile-compose-13a/mutate.py`.

**Drift from the Implementation (and why).**

1. **Three helpers the plan did not name, all inside 13a's own file.** The plan
   listed `compose-queue.ts` as "shown rows (D2), hand-back (D3), send-now
   take/restore" without naming functions; the built module also carries
   `restoredByRefusal`, `settleReclaim` and `settleOwn`. `restoredByRefusal`
   and `settleOwn` are needed by a *pure* D3/D4 bound the plan states in prose
   ("ids I already restored after a send-now refusal are only reclaimed";
   "`ownIds` … loses it when the daemon no longer lists it") — putting either
   in the screen would violate §7's "logic lives in pure modules", and both are
   client-side truths 13d would otherwise re-derive. `settleReclaim` exists
   only so `handBackStep` is testable without an async port. No new file, no
   new dependency, nothing 13b/13c touch.
2. **A changelog fragment was written; the plan says "13a, 13b, 13c: none".**
   The executor brief (and the task instruction) requires one fragment per
   task, and this slice is not internal-only in the §10 sense — it is a new
   shipped module (render-inert until 13d, which is exactly what 12b's
   `mobile-session-view-12b.added.md` looked like). Written at 13d's merge
   intent minus the screen. If the orchestrator prefers the plan's "none", the
   fragment is one file to drop.
3. **`ShownRow` is a projection, not `QueuedRow` spread.** My first cut spread
   the local row, so the TUI's tracking flag `acked` reached the screen's view
   model — a presentation leak, caught by the test and fixed: the row is
   `{id, text, state, mine}` only.
4. **`planHandBack` takes a `Pick<QueueState, "returned">`**, not the whole
   `QueueState`, so the parity fixture can pass a subset; the client's
   `handBack` takes the full type and both were compared on full states, so the
   narrowing is test-ergonomics only.
5. **F13–F23 (and 13b/13c/13d entirely) are not in this slice** — untouched, as
   instructed; `apps/mobile/package.json`, `bun.lock`, `app.json`,
   `connection.ts`, `packages/core`, `packages/tui` are unmodified.

**Not verified here.** 13a has no screen and no Maestro flow (its E2E belongs
to 13d, which needs 12c + 13b + 13c); the parity pin is in-process only, so
"the phone shows these rows" is unverified until 13d renders them. How to
verify: 13d's `session-view.test.ts` + Maestro `12-steer` / `14-returned-mine`
/ `15-returned-other` (plan "Maestro").

*— deepseek-v4.1-flash-1017, 2026-11-14*
*— deepseek-v4-pro (via tentacle), 2026-11-14 — slice **13b `mobile-outbox`** only*

**Load-bearing check (re-run first, as briefed) — PASSES.** Static: `turns` is a
lifetime ledger, checked before anything runs (`hosted-session.ts:452-456`,
`:1993-1996`, `:1997` "a rejected prompt starts and records nothing"), restored on
reload (`:634-636`, `:1245-1248`, `:1264`); `enqueue`'s id is checked before the
running check and binds to the exact turn (`:2694-2703`, `:2715-2721`), ids
restored (`:637-640`). Empirical (`.tentacle/tmp/mobile-compose-13b/probe.test.ts`,
2 pass): the SAME `turnId` sent twice by two clients → ONE user message; the SAME
enqueue id twice → ONE queued row. No step contradicted the plan; nothing was
stopped.

**As-built, in dependency order.**

1. `apps/mobile/src/outbox.ts` (new, pure) — the item model, `createItem` (both
   keys minted ONCE at creation), `decide` (D4's table), `unchanged`, `asSteer`,
   `refusalOf` (class/code → `offline` / `restore` / `decide` / `reupload`),
   `withRef`/`refsOf`/`pendingUploads`, `reuploaded`, `addOwnIds`/`pruneOwnIds`,
   `restoredOf`.
2. `apps/mobile/src/drafts.ts` (new, pure) — `draftKey` (the `(computer,
   session)` PAIR), `createDraftScheduler` (debounce 400 ms, injected clock,
   `touch`/`take`/`force`/`dueIn`/`clear`), `draftOf`/`contentOf`.
3. `apps/mobile/src/outbox-store.ts` (new) — versioned JSON (`schemaVersion: 1`)
   over an injected `OutboxFs`; tmp + rename; unknown version refused and left
   untouched (read-only thereafter); unparsable set aside `.corrupt-<ts>`, never
   deleted; a failed write answers `false` (the `not-saved` banner) with the
   memory state kept; `removeItem` deletes the photo copies; `outboxPaths`
   escapes the computer id (a path segment never escapes the root). *(Fix round
   1 serialised writes and made a set-aside file writable again.)*
4. `apps/mobile/src/outbox-driver.ts` (new) — per-session serialised `run` over
   an injected `OutboxSession`; `enqueue` (persist BEFORE any attempt);
   `sendNow`/`steerNow`/`discard`/`backToDraft`; one photo at a time, each ref
   persisted before the next. *(Fix round 1 added `outbox-session.ts`, the real
   port — the steer's turn binding — and put every sheet act behind `exclusive`.)*
5. Tests (new): `outbox.test.ts` (21), `drafts.test.ts` (11),
   `outbox-store.test.ts` (13), `outbox-driver.test.ts` (24),
   `outbox-link.test.ts` (8, real `SessionHost` + `Connection` + real
   `RemoteClient`s). *(Counts are as first built; Fix round 1 adds T9/T10 and
   five driver/store cases — see below.)*
6. No changelog fragment (13b is app-internal; 13d's branch writes
   `mobile-compose.added.md`). The first executor DID add
   `changelog.d/mobile-compose-13b.added.md`; Fix round 1 removed it (Review
   finding 5).
   No protocol change; `packages/protocol/schema/protocol.json` untouched (P11).

**Drift from the Implementation (and why).**

- **D4's `basis`** is `{historyLength, runningTurnId}`, not the plan's
  `{history length, last turn id, turn running?, compaction epoch}`. Verified:
  `RemoteSession` exposes no ended-turn id and no compaction epoch publicly
  (`remote-session.ts:219-221` `busy`, `:286` `ownsTurn`); a compaction, a
  `/clear` and any new message all change `historyLength`, so the property D4
  needs ("nothing the person could see changed") is preserved by the two fields
  that ARE observable. `decide`'s "our key IS the running turn" row still uses
  the key, so F3 is unchanged.
- **The running turn's id** is taken from `SessionActivity{kind:"turn"}` (the
  `watch` the app already subscribes, `remote-session.ts:1424`), not from a
  snapshot field — `SnapshotTurnSchema` exists on the wire but
  `RemoteSession.snapshot()` returns messages only (`:945-947`). 13d's
  `session-view.ts` receives exactly this activity; the driver's port keeps it
  as one injected fact.
- **`Decision` gained `wait`** (and `Refusal` `offline`): a `link` availability
  is a "no answer yet, keep it", never a decision on stale facts. Additive to the
  plan's table (F1/F6 converge the same way).
- **One re-upload (F18) is marked on the item** (`reuploaded?: true`) rather than
  inferred from "refs are empty": the driver's first attempt records refs as it
  uploads, so an empty-ref check misread a `not_uploaded` refusal for a fresh
  item (an actual bug the F18 test caught — fixed before the test went green).
- **`outbox-driver.test.ts` is an extra file** beyond the plan's list: the plan's
  13b row names `outbox.test.ts`/`drafts.test.ts`/`outbox-store.test.ts`/
  `outbox-link.test.ts`; the sequencing and every refusal's landing spot are
  driver behaviour, and testing them through the real daemon would need one
  daemon per case. `outbox-link.test.ts` still proves the load-bearing property
  end to end.
- **The harness detail worth recording**: a second `newSession` of one id on the
  SAME client replaces that client's stream listener, which silently makes an
  "observer" client steal the turn under test. Every probe in
  `outbox-link.test.ts` therefore uses a scratch client.

**Mutations (run red, then reverted — `mutate.py`, no `git`).**

| # | Mutation | Test that went red |
|---|---|---|
| M1 | a fresh `turnId` per attempt (`outbox-driver.ts`) | link T1 |
| M2 | ignore `basis` → always `send` (`outbox.ts`) | link T4 |
| M3 | treat `archived` as openable (`outbox.ts`) | link T6 |
| M4 | re-mint `enqueueId` per attempt (`outbox-driver.ts`) | link T2 |
| M5 | in-memory own ids, not the persisted set (test arg) | link T8 |
| M6 | a refusal routed to `decide` instead of `restore` | link T7 |
| M7 | loop on `not_uploaded` (drop the `reuploaded` guard) | driver "second `not_uploaded`" |
| M8 | write in place, no tmp+rename | store "kill between tmp and rename" |
| M9 | overwrite an unknown-version file | store "unknown schemaVersion" |
| M10 | delete a corrupt file instead of setting it aside | store "SET ASIDE" |
| M11 | ignore "the running turn IS our key" | outbox "already ran" |
| M12 | compare the history length only | outbox "unchanged compares BOTH" |
| M13 | reuse the prompt key for a steer | outbox "Queue as steer" |
| M14 | `handedBack` forgotten (give twice) | link T8 |
| M15 | attempt before persisting the item | driver "BEFORE any attempt" |
| M16 | prune own ids with no live-queue guard | outbox "own ids added once" |

Every mutation was applied to a saved copy and reverted immediately; the tree
holds only the intended files (`git status` showed the 9 new source/test files
plus the changelog fragment, which Fix round 1 removed — Review finding 5).

**Gate (as run on this branch).** `bun run typecheck` — clean. `bun run lint` —
`Checked 1073 files … No fixes applied` (the baseline in AGENTS §6). `bun test` —
see the gate line in the branch report; the slice's own five files are 77 pass /
0 fail.

**Not verified here (13d's job, one line each).** The `expo-file-system`
implementation of `OutboxFs` and the `AppState`/draft wiring are 13d's
(`outbox-fs-expo.ts`, `App.tsx`); the photo pipeline (`readPhoto`'s bytes, HEIC,
size, names) is 13c's — this slice takes a photo as `{file, mimeType, name}` and
reads its bytes through the injected port.

### Fix round 1

*— claude-opus-5-5, 2026-11-14 — fixes the five findings of Review round 1.*

**Reproduced first, on the pre-fix tree** (`bun test` in
`.tentacle/tmp/mobile-compose-13b/`, the reviewer's three repro files unchanged):

```
RESULT steer ids ["k4","k5"]                       # finding 2: two enqueue ids
RESULT [true,true] memory ["a","b"] disk {... "ownIds":["a"]}   # finding 3: lost update
RESULT items [] decisions [] drafts [] methods ["session/open","session/snapshot"]
       userTexts ["hi","hold please"]              # finding 1: text gone, no frame
```

All three reproduce. Each is now fixed, with the repro's own numbers as the
assertion, and each fix was mutation-checked (§9) — details per finding.

Re-run after the fixes (same three files, unchanged): `steer ids ["k4"]` (one),
disk `ownIds:["a","b"]` (the newest state), and — for R1 — the same
`items [] … methods ["session/open","session/snapshot"]`, because **that file
builds its own port with the buggy `steer: (text, id) => session.enqueue(text,
id)` inline** (`review-steer-race.test.ts:297`): it reproduces the OLD adapter,
not the app. The equivalent assertion against the app's real wiring is T9/T10,
which are red under exactly that mutation (see finding 1).

**1. HIGH — a steer vanished, or steered a later turn.** Root cause: the port's
`steer` had no adapter, and `RemoteSession.enqueue(text, id)` (its two
parameters are assignable to the three-parameter shape, so the compiler was
silent) binds to whatever turn the CLIENT believes runs and resolves without
sending when it sees none (`remote-session.ts:958-963`). New
`apps/mobile/src/outbox-session.ts`: `outboxSessionOf(session, client,
runningTurn)` routes a steer to `RemoteClient.enqueue(sessionId, id, turnId,
text)` (`remote-client.ts:2090`), which the daemon checks against its own
`activeTurnId` (`hosted-session.ts:2700-2720`) and refuses `NoTurnRunning` — a
refusal the app SEES (`refusalOf` → `{decide, "no-turn"}` → `needs-decision`).
`unavailableSessionPort` is the same module's port for an unopenable session, so
the adapter is one place, not an inline closure in a test. The port's doc
comment (`outbox-driver.ts:41-50`) no longer claims `RemoteSession` satisfies it
structurally, and `outbox-link.test.ts` now builds its port from
`outboxSessionOf` — the real app wiring, not a test-only copy.
Tests: link **T9** (turn ended before the enqueue: the `session/enqueue` frame
carries the ITEM's `turnId` and id, the decision is `no-turn`, the text is never
in the transcript) and **T10** (a NEW turn runs: the frame still names the old
turn, the item survives, and the later turn's history never gains the text).
Mutation: `steer` back to `session.enqueue(text, id)` → T10 red with the
repro's own evidence — `enqueue turnId` = the LATER turn, the item's list empty
(finished): `PROBE enqueue {"id":"mint-3","turnId":"0d70c305…","text":"steer
me"}` vs the item's `mint-3` turn; plus `expect(items state)` received `[]`.

**2. MEDIUM — a double tap of "Queue as steer" sent two steers.** Root cause:
`steerNow`/`sendNow` skipped both `serialise` and `busy`, re-read nothing, and
`asSteer` mints a fresh `enqueueId` per call on a prompt item. Now both (and
`discard`/`backToDraft`) go through one helper, `exclusive(sessionId, itemId,
body)` (`outbox-driver.ts:336-352`): it queues on the same per-session tail a
`run` uses, then RE-READS the item from persistence inside the queue and marks
it `busy`, so the second tap finds it either gone (the first finished it — a
no-op) or already the steer the first made, whose `enqueueId` `asSteer` keeps
when `steerTurnId` matches. Tests: driver "a DOUBLE tap of Queue as steer is ONE
enqueue with ONE id", "a second tap after the first act finished finds nothing
to do", "a double tap of Send is ONE prompt". Mutation: `steerNow` back to the
unserialised body → the first two red (two ids `["k4","k5"]`, and a second send
from the stale copy); reverting `exclusive` to drop `busy` → the Send double tap
red. The reviewer's own repro now answers `steer ids ["k4"]`.

**3. MEDIUM — store writes were not serialised and shared one tmp path.** Root
cause: one store is one file per computer, but the driver serialises per
SESSION and drafts / own ids write independently, so two writes could interleave
with the slower (older) one landing last. `outbox-store.ts:258-300`: every write
now goes through one queue (`writeTail`; the memory state is set at once, so a
slow disk never makes a person re-tap), and the queue is also what makes the
single `<state>.tmp` name safe — the per-write tmp name I first added was
unreachable once writes were queued, so it was removed (one mechanism, not two).
Tests: store "overlapping writes land in order: the NEWEST state is on disk",
"two writers that both change the file (items + own ids) do not overwrite each
other" (both collections survive a relaunch), "a write that fails leaves the
queue usable". Mutation: `write` straight to `persist` (no queue) → the first
two red `[true,true]` with disk `ownIds:["a"]` — the reviewer's exact repro;
a rejected tail that poisons the queue was covered by the third.

**4. MEDIUM — the not-saved contract differed between the fake and the real
store.** Root cause: the real store keeps a failed write in memory
(`outbox-store.ts:256`), while the driver's fake dropped it and `enqueue`
answered `null` for it — so `.null` could only ever mean "in memory, not on
disk", which a screen reading it as "not created" answers by keeping the text
and having the person send it again under fresh keys (F4). Fixes: `enqueue`
answers `OutboxItem` (never null; the `not-saved` banner carries the durability
news) with its contract spelled out on `OutboxPersistence.save` and on the
method; the driver test's fake now mirrors the real store (keeps the state,
answers `false`). Second half: after a SUCCESSFUL set-aside the store stayed
read-only for the process, with no file left to protect — `readOnly = !moved`,
so only a corrupt file that could NOT be moved keeps it read-only (its bytes are
then still the only copy). Tests: driver "a disk that will not write keeps the
item and says not-saved — never answers 'not created'", "an item created while
the write failed still goes out on the next run", store "an unparsable file is
SET ASIDE, never deleted, and the store then works again", "a corrupt file that
could NOT be moved aside leaves the store read-only". Mutations: `enqueue`
returning null on a failed write → the first red; `readOnly = true` after a
successful set-aside → the store test red.

**5. MEDIUM (process) — an unplanned changelog fragment.** Removed
`changelog.d/mobile-compose-13b.added.md`: the plan's header says 13b gets none
(13d writes `mobile-compose.added.md`, the first user-visible slice), and 13b is
app-internal with no screen yet (AGENTS §10). `git status` shows it deleted on
this branch.

**Gate (as run).** `bunx tsc --noEmit` — clean; `bunx tsc -p apps/mobile
--noEmit` — clean. `bun run lint` — `Checked 1074 files … No fixes applied`
(baseline, AGENTS §6). `bun test` — **8364 pass / 3 skip / 0 fail** across 600
files (the three skips are the opt-in live-k8s, live-docker and real-socket
ones). The slice's five files are 87 pass / 0 fail (was 77: +T9, +T10, +4 driver,
+4 store, and one store test rewritten).

**Two load-flakes seen on the way, not mine and not new** (recorded here because
the gate was not green on the first four full runs): three runs each failed one
*different* test outside this diff — `packages/exec/test/confinement.test.ts` F2
and R2-4 (a hard-link race under load) and
`packages/cli/test/context-reset-e2e.test.ts` — and each was 3/3 green alone
right after. That is the timing-flake-under-load class already logged in
`TODO.md:447`. `git status` at every failure held only this slice's files; the
next full run was clean.

**Kept from Review as debt, not fixed here.** `refusalOf`'s
`SessionLostError`/`UploadAbortedError` name checks are dead (their `.name`
values are `RpcError`/`AbortError`); both land on `decide`, which is safe. The
13a carry-forward (`handedBack` not persisted) is 13d's.

### Fix round 2

*— claude-opus-5-5, 2026-11-14 — fixes the one MEDIUM finding of Review round 2.*

**Reproduced first, on the pre-fix tree** (`.tentacle/tmp/mobile-compose-13b/`,
the reviewer's own `review-r2-notopen.test.ts`, unchanged):

```
RESULT state ["needs-decision"] decisions ["refused"]      # a link drop shown as a refusal
```

After the fix, the same file, unchanged: `RESULT state ["waiting"] decisions []`
— the item stays, and there is nothing for a person to settle.

**1. MEDIUM — a link drop was shown as the daemon's refusal.** Root cause:
`SessionNotOpenError` was the app's own marker for "this act never reached the
wire", and its doc said `refusalOf` read it as offline
(`outbox-session.ts:24-26`), but `refusalOf`'s name list did not contain it, so
it fell through to the `default:` arm → `decide/refused` — a decision sheet for
a network blip. The same miss cut the other way too: `unavailableSessionPort`
serves BOTH a session that could not be opened (`link`) and one the daemon says
is archived/deleted/gone, and the error carried no reason, so the archive case
could only be reached through `facts()` — the sheet's Send ran into the error
first and showed a refusal instead of handing the text back (F20).

Fix, in three places that must not drift apart:
- `outbox.ts:268-292` + `:319-330`: a new pure `notOpenRefusal(availability)`
  (`outbox.ts:286`) is the ONE mapping — `link` → `offline` (item stays
  `waiting`, F1), anything else → `draft` with its why (text back in the field,
  F20) — plus a `draft` member on `Refusal`; `refusalOf` reads
  `SessionNotOpenError` through it.
- `outbox-session.ts:23-48`: the error carries `availability` (default `link`),
  and `unavailableSessionPort` passes its own reason into it, so one port can
  say which state it is in.
- `outbox-driver.ts:272-276` (`refuse`: a `draft` hands the content back through
  `removeAndHand`) and `:411-418` (`steerNow` reads the availability BEFORE the
  running turn: a session that is not open has no turn to name, so asking
  `runningTurnId` first settled a dropped link as `no-turn`).

Tests: outbox "a dropped link is 'offline' for every act" now includes
`SessionNotOpenError`; driver "the sheet's Send with the link DOWN keeps it
waiting, never a refusal", "Queue as steer with the link DOWN keeps it waiting
too", "the sheet's Send on an ARCHIVED session hands the text back, never a
refusal". `outbox-link.test.ts` also stops keeping its own `unopenedPort` (a
bare `Error`) and uses the APP's `unavailableSessionPort` — the same test-only
copy that hid round-1 finding 1; all 10 link tests stay green with the real one.

**Mutations (run red, then reverted — `mutate.py`, no `git`).**

| # | Mutation | Test that went red |
|---|---|---|
| M-A | drop the `SessionNotOpenError` arm from `refusalOf` | outbox "a dropped link is 'offline'"; driver "Send with the link DOWN" |
| M-B | `steerNow` asks `runningTurnId` before the availability | driver "Queue as steer with the link DOWN" |
| M-C | `notOpenRefusal` answers `offline` for every state | driver "Send on an ARCHIVED session hands the text back" |

`git status` after each held only this round's six files (no `.backup`).

**Gate (as run on this branch).** `bunx tsc --noEmit` — clean; `bunx tsc -p
apps/mobile` — clean. `bun run lint` — `Checked 1074 files … No fixes applied`.
`bun test` — 8367 pass, 3 skip (the opt-in live-k8s / live-docker / slow-keepalive
ones), 0 fail, 600 files.

**Not verified here.** `unavailableSessionPort`'s `upload`/`prompt` arms are
reached in the app only through 13d's compose wiring; this round proves the
`steer`/`prompt` refusal mapping and the facts path (the three driver tests and
the 10 link tests), not 13d's screen code, which does not exist yet.


## Review

#### Orchestrator decisions (owner night delegation 2026-11-14)

Owner asleep, delegated: every Owner question above is decided with its RECOMMENDED option. Implementation APPROVED.

### 13a `mobile-compose-queue` — Review

**Verdict: APPROVE-WITH-NITS** (no HIGH/MEDIUM finding against 13a's own scope).

- **Gate (scope = `git diff main...HEAD`):** `compose-queue.test.ts` + `compose-queue-parity.test.ts` 55 pass / 0 fail; `bun run lint` clean (1067 files); `bun run typecheck` clean. The full `bun test` was not re-run (the diff adds only app-local files and tests).
- **Mutations (9, each reverted, tree byte-clean per `git status`):** drop `handedBack` 2 fail; auto-reclaim others' rows 3 fail; `settleOwn` ignores `keep` 1 fail; `settleOwn` drops returned 1 fail; no `reclaiming` filter 1 fail; Take allowed on a row of mine 1 fail; `carried` ignored 2 fail; daemon text shown for a row of mine 1 fail; text given back from the daemon instead of `own` 5 fail. Every one goes red.
- **Parity:** `shownRows`, `takeForSendNow`, `handOff`, `afterRefusal`, `onReject`, `returnedNotice`, `restoredByRefusal`, `planHandBack` are line-for-line the TUI's `queued.ts` / the client's `hand-back.ts`. The parity file imports them for real (test-only relative imports), and it fails under M1, M2 and M9 too.
- **§7 checks:** pure, with no React and no I/O. The text given back always comes from `own`, never from the daemon (the untrusted-pod rule; pinned by M9). Another writer's text reaches the field only through `takeReturned`, which is an explicit act. No protocol change, and no `packages/*` edits.
- **Attacks that found nothing:** a duplicate id in `returned` is given back only once (`seen`). A reclaim that fails is retried without a second hand-back (`settleReclaim` + `handedBack`). Take on a row of mine, or on an unknown id, is a no-op. An empty `held` or a malformed one restores everything, which matches the client.
- **Carry-forward (13b/13d, not 13a):** the store D4 plans (`{items, drafts, ownIds}`) does not persist `handedBack`. Failure case: a row is given back into the field, the draft is saved, and the app is killed before the reclaim lands. On relaunch, `own` still has the id and `handedBack` is empty, so `handBackStep` gives the row back a second time. 13b/13d must persist `handedBack` (or drop the id from the given set) to keep F10's "once" across a kill.
- **Nits:** `shownRows` marks `mine` only from `own`. A local row whose id 13d forgot to add to `own` would show as "from another device", so 13d must add the id to `own` before calling `addRow` (D4 already says this). The `changelog.d/mobile-compose-13a.added.md` fragment goes against the plan header ("13a: none") and duplicates 13d's planned fragment. The 12b precedent exists, so this is the orchestrator's call; the executor flagged it openly (Drift 2).
- **Executor behaviour:** stayed in scope, gave an honest drift list, and ran the named mutations red. Execution's claims held up when checked.
- **Same-family note:** the reviewer (Opus) is a different model family from the executor (DeepSeek).

*— claude-opus-5-5, 2026-11-14*
#### Review — slice 13b `mobile-outbox` (fresh context)

*— claude-opus-5-5, 2026-11-14*

**Verdict: REQUEST-CHANGES.** Executor: deepseek-v4-pro; reviewer is a different
model family. Scope: `git diff main...HEAD` only.

**Gate (re-run here):** the 5 touched test files 77 pass / 0 fail (240
expects); `bun run lint` clean (1073 files); `bun run typecheck` clean. Full
`bun test` not re-run in this pass.

**Mutations (applied, run, reverted; `git status` clean after):** fresh
`turnId` per attempt (`outbox-driver.ts:207`) → 2 red incl. link T1;
`unchanged()` always true (`outbox.ts:209`) → 5 red incl. link T4; write in
place, no tmp (`outbox-store.ts:260`) → store "kill between tmp and rename"
red. The tests that exist are not vacuous.

**Findings**

1. **HIGH — a steer can vanish silently or steer a later turn.**
   `OutboxSession.steer(text, id, turnId)` (`outbox-driver.ts:54`, called
   `:199`) is meant to bind the steer to `steerTurnId`, but the only adapter
   (`outbox-link.test.ts:296`, and the driver's own doc `:42-43`, "RemoteSession
   satisfies it structurally") routes it to `RemoteSession.enqueue(text, id)`,
   which ignores that turn, uses the client's current one, and **resolves without
   sending** when it sees none (`client/src/remote-session.ts:958-963`). The
   driver then `finish`es the item (`:216`). Repro
   (`.tentacle/tmp/mobile-compose-13b/review-steer-race.test.ts`, T3 with the
   facts read just before the turn ended): `items [] decisions [] drafts []
   methods ["session/open","session/snapshot"] userTexts ["hi","hold please"]`.
   The text is gone, with no banner, no sheet, no Enqueue frame. If a new turn
   started in that window, the steer goes into that later turn. Both break F9 and
   the plan's "never steers a later turn". Fix: route the port to
   `RemoteClient.enqueue(sessionId, id, turnId, text)` (`remote-client.ts:2090`,
   public), correct the doc comment, and add this race as a link test.
2. **MEDIUM — the sheet's "Queue as steer" double tap sends two steers.**
   `steerNow` (`outbox-driver.ts:349-359`) and `sendNow` (`:339`) skip both
   `serialise` and `busy`, and they do not re-read the item. `asSteer` mints a
   fresh `enqueueId` for each call on a prompt item (`outbox.ts:226`). Repro
   (`review-steer-twice.test.ts`): two concurrent `steerNow(item)` produce steer
   ids `["k4","k5"]`, so the text is injected twice. This contradicts F4. A
   second tap after the first act finished also re-sends from the stale object.
3. **MEDIUM — store writes are not serialised and share one tmp path**
   (`outbox-store.ts:255-268`). The store is one file per computer, while the
   driver serialises only per session, and drafts and ownIds write
   independently. Repro (`review-store-race.test.ts`, the first write slower):
   both writes answer `true`, memory holds `["a","b"]` and disk holds
   `ownIds:["a"]`. That is a silent lost update: after a kill, an item, a ref or
   an own id is gone, or a finished item comes back.
4. **MEDIUM — the not-saved contract differs between the fake and the real
   store.** The real store keeps a failed write in memory (`outbox-store.ts:256`),
   so `enqueue` answers `null` (`outbox-driver.ts:337`) while the item is live and
   the next `run` sends it. The driver test's fake drops it instead
   (`outbox-driver.test.ts:101-105`), so this path is untested. A screen that
   reads `null` as "not created, keep the text" gets a re-tap and a second item
   with new keys. After a SUCCESSFUL set-aside of a corrupt file, the store also
   stays read-only for the rest of the process (`:290`, pinned by the test at
   `outbox-store.test.ts:209`), with no file left to protect. Every compose until
   relaunch is then memory-only.
5. **MEDIUM (process) — an unplanned changelog fragment.** The plan header says
   13b gets none, and 13d writes `mobile-compose.added.md`. This branch adds
   `changelog.d/mobile-compose-13b.added.md`, which itself says "No screen
   changes yet". That is internal work, so the release would list the feature
   twice (AGENTS §10). It is not listed under Drift.

**Attacks that found nothing:** the keys are minted once at creation and
persisted before any attempt (`createItem`, `enqueue`). `decide`'s ordering
gives archived/deleted/gone priority, and no reopen is sent (T6). Refusals
branch on class or code, never on message text. `not_uploaded` is re-uploaded
once and then shown (`reuploaded` flag). An unknown `schemaVersion` leaves the
file's bytes untouched. A `computerId` path cannot escape the root. No protocol
or `packages/*` change (P11 holds). Low, not blocking:
`refusalOf`'s `SessionLostError` / `UploadAbortedError` name checks are dead,
because their `.name` values are `RpcError` / `AbortError`. Both land on
`decide`, which is safe.

**Executor:** a thorough slice with honest drift notes and real mutations. The
blind spot is the port's adapter: the load-bearing property was proved for
prompts end to end, but for steers only up to the client method, whose turn
binding is not the item's.

### Round 2

*— claude-opus-5-5, 2026-11-14* · scope `git diff HEAD~1` (7f98779)

**Verdict: REQUEST-CHANGES**, for one small new finding. All five round-1 findings are fixed.

**Gate:** the 5 touched files pass 87/87 (274 expects). `bun run lint` is clean
(1074 files) and `bun run typecheck` is clean.

**Round-1 findings, each checked by mutation.** Four mutations were applied
together, the tests run, then reverted; `git status` was clean afterwards.
- **#1 (HIGH), fixed.** `outbox-session.ts` sends the steer through
  `RemoteClient.enqueue(sessionId, id, turnId, text)`. Mutation: route it to
  `session.enqueue(text, id)` → link T9 (turn ended) and T10 (new turn) fail.
- **#2, fixed.** `exclusive` (serialise + busy + re-read of the item) wraps the
  sheet's acts. Mutation: no `exclusive` in `steerNow` → "DOUBLE tap … ONE id"
  and "second tap after the first finished" fail.
- **#3, fixed.** The store writes through one queue (`writeTail`). Mutation: no
  queue → both "two writers at once" tests fail.
- **#4, fixed.** `enqueue` always returns the item. A corrupt file that was moved
  aside is writable again (`readOnly = !moved`). Mutation: stay read-only → the
  "SET ASIDE … works again" test fails.
- **#5, fixed.** The changelog fragment is deleted.

**New finding**

1. **MEDIUM — `SessionNotOpenError` is not read as offline.** Its doc says
   `refusalOf` reads it as "no answer from the daemon", so the item stays
   `waiting` (`outbox-session.ts:24-26`). But `refusalOf`'s offline list
   (`outbox.ts:301-307`) does not name it, so it falls through to
   `decide/refused`. Repro (`.tentacle/tmp/mobile-compose-13b/review-r2-notopen.test.ts`):
   the sheet's Send while the link is down gives `getSession` →
   `unavailableSessionPort("link")` → `perform` → state `needs-decision`, why
   `refused`. The plan (F1) says it should be `waiting`. Before this commit,
   `getSession` returning `null` gave `waiting`. Nothing is duplicated or lost:
   the item stays on disk. But a link drop is shown as a refusal. Fix: add
   `"SessionNotOpenError"` to the offline names, plus a test.

**Regressions checked with no finding:** `exclusive` runs inside the session's
`serialise` chain and no act calls `serialise` again, so it cannot deadlock.
`busy` is clear between serialised runs. The write queue recovers after a
failed write (it has its own test). `discard` and `backToDraft` on an item that
is already gone are no-ops.

### Round 3

*— claude-opus-5-5, 2026-11-14* · scope `git diff HEAD~1` (35f7355)

**Verdict: PASS.**

**Gate:** the 5 touched files pass 90/90 (286 expects). `bun run lint` is clean
(1074 files) and `bun run typecheck` is clean.

**Round-2 finding, fixed and checked by mutation.** The mutations were applied,
run and reverted; `git status` was clean afterwards.
- **What changed:** `refusalOf` now handles `SessionNotOpenError` through
  `notOpenRefusal`. A link that is down maps to `offline`; an archived, deleted
  or gone session maps to the new `draft` refusal, which `refuse` hands back to
  the field.
  - Mutation A: drop the branch → "Send with the link DOWN keeps it waiting",
    "Send on an ARCHIVED session", and the `refusalOf` offline-names test fail.
  - Mutation C: `notOpenRefusal` always answers `offline` → the ARCHIVED test
    fails.
- **What changed:** `steerNow` checks `facts.availability` before the running
  turn. Mutation B: skip that check → "Queue as steer with the link DOWN" fails.
- **The round-2 repro now ends `waiting`, with no decision**
  (`.tentacle/tmp/mobile-compose-13b/review-r2-notopen.test.ts`).

**Regressions checked, none found:**
- `refuse` handles every `Refusal` kind; the compiler checks the switch.
- A `draft` refusal from inside an upload hands the item back and never reopens
  the session (F20).
- The link test now uses the app's own `unavailableSessionPort`, not a
  test-only copy that threw a bare `Error`.
- The steer is still turn-bound (`client.enqueue`).
- The name check is safe: wire errors arrive as `RpcError`, so a daemon cannot
  forge the `SessionNotOpenError` name.

**Executor:** fixed exactly the finding, at its root (one mapping used in three
places), with tests that name their mutations.
