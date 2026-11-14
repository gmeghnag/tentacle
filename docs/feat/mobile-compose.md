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
   escapes the computer id (a path segment never escapes the root).
4. `apps/mobile/src/outbox-driver.ts` (new) — per-session serialised `run` over
   an injected `OutboxSession`; `enqueue` (persist BEFORE any attempt);
   `sendNow`/`steerNow`/`discard`/`backToDraft`; one photo at a time, each ref
   persisted before the next.
5. Tests (new): `outbox.test.ts` (21), `drafts.test.ts` (11),
   `outbox-store.test.ts` (13), `outbox-driver.test.ts` (24),
   `outbox-link.test.ts` (8, real `SessionHost` + `Connection` + real
   `RemoteClient`s).
6. `changelog.d/mobile-compose-13b.added.md` (one bullet).
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
holds only the intended files (`git status` shows the 9 new source/test files
plus the changelog fragment).

**Gate (as run on this branch).** `bun run typecheck` — clean. `bun run lint` —
`Checked 1073 files … No fixes applied` (the baseline in AGENTS §6). `bun test` —
see the gate line in the branch report; the slice's own five files are 77 pass /
0 fail.

**Not verified here (13d's job, one line each).** The `expo-file-system`
implementation of `OutboxFs` and the `AppState`/draft wiring are 13d's
(`outbox-fs-expo.ts`, `App.tsx`); the photo pipeline (`readPhoto`'s bytes, HEIC,
size, names) is 13c's — this slice takes a photo as `{file, mimeType, name}` and
reads its bytes through the injected port.


## Review

#### Orchestrator decisions (owner night delegation 2026-11-14)

Owner asleep, delegated: every Owner question above is decided with its RECOMMENDED option. Implementation APPROVED.
