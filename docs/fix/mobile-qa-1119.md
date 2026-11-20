# fix/mobile-qa-1119 — iPhone photos: blank viewer, offline photo dropped, pixels lost on resync

> **Status:** execution
> **Branch:** `fix/mobile-qa-1119`
> **Size:** M · **Blast:** cross-module · **Suited:** Opus executes; fresh-context Review
> **Changelog:** `changelog.d/mobile-qa-1119.fixed.md`

Type: fix · Size: M · Blast: cross-module · Suited: Opus.

## Context

*— claude-opus-5-5, 2026-11-20*

The simulator QA of main @224d0f32 (`.tentacle/tmp/mobile-qa-1119/REPORT.md`,
2026-11-19) found two BLOCKERs and four BUGs around photos and the outbox. The
owner approved fixing rows 8–12 and 17 (2026-11-20), in this order:

| QA row | Symptom (from the report) |
|---|---|
| 8 BLOCKER | the photo viewer opens ("1 of 4", paging works) but draws NO photo; ✕ does nothing; only killing the app gets out |
| 9 BLOCKER | photo picked with `serve` down: chip spins, Send queues, text + chip vanish; after reconnect the message goes out with **0 images** |
| 10 BUG | offline text-only message: no "Waiting for network" row |
| 12 BUG | every sent photo becomes "Image not available" after background → foreground, a `serve` restart or a relaunch |
| 11 BUG | two byte-identical photos in one message → turn `lost` in 5 ms, the decision sheet loops for ever |
| 17 LOW | the hub covers the end of the last transcript row at rest |
| 13/14 | NOT VERIFIED (upload veil/%; "+N" for > 4 photos): one attempt each |

**Repro** (2026-11-20, own simulator AF01E641 iPhone 17 iOS 26, the QA's own
Release build of 224d0f32 installed over a `run.ts --hold` pairing; `serve` on
127.0.0.1:54090, hooks 127.0.0.1:54114; Maestro flows in
`.tentacle/tmp/mobile-qa-1119-fix/flows/`):

- **Row 8.** Send 2 photos, tap the first tile → viewer up, `hierarchy`:
  `media-viewer [0,0][402,873]`, `media-viewer-count "1 of 2" [16,21][340,38]`,
  `media-viewer-close [354,14][386,45]`, **no image node**; screenshot: the
  count and ✕ drawn over the status bar, the transcript dimmed, no photo.
  `tapOn media-viewer-close` → `Assertion 'id: media-viewer is not visible' failed`.
- **Row 12.** Same session after `simctl terminate` + relaunch: both tiles of
  "PHOTO 2 tiles" draw "Image not available".
- **Rows 9/10.** `stop-serve` hook, type "PHOTO offline", pick one photo → the
  chip spins (`chip-0-uploading`), then the hierarchy shows `chip-0-refused`
  and the red notice "no connection — this photo goes up when the phone is
  back online". `composer-send-later` → field + chip gone, **no outbox row**;
  then "TEXT offline" + send-later → also gone, no row, no `waiting-network`.
  (Row 10 is the bug fix/mobile-e2e-reds already fixed on main — `offlineBasis`
  — so it is re-checked on this branch's build, below.)
- **Row 11** (headless, `.tentacle/tmp/mobile-qa-1119-fix/dup/repro.ts`: the
  `remote-session-attach.test.ts` in-process daemon, one image attached twice,
  one prompt naming both refs):
  ```
  result: RpcError: a.png sha256:a1c4d088c1cf: the same image is attached twice 1ms
  prompt frame sent: true
  ```
  The script is `remote-session-attach.test.ts`'s first 130 lines (its
  `daemon()`/`drain()` helpers, imports pointed at `packages/client/src`) plus:
  ```ts
  const d = daemon();
  const a = d.dial();
  await a.client.initialize();
  const session = a.client.newSession(undefined, crypto.randomUUID());
  const bytes = bytesOf("same png");
  const r1 = await session.attachImage(bytes, { mimeType: "image/png", name: "a.png" });
  const r2 = await session.attachImage(bytes, { mimeType: "image/png", name: "a.png" });
  const events: SessionEvent[] = [];
  const t0 = Date.now();
  const out = await drain(session.send("two", undefined, { attachments: [r1, r2] }), events);
  console.log("result:", out instanceof Error ? `${out.name}: ${out.message}` : out, `${Date.now() - t0}ms`);
  console.log("prompt frame sent:", a.frames.some((f) => f.method === "session/prompt"));
  ```
  The refusal is `checkAttachmentRefs` (`packages/core/src/attachments.ts:100`),
  a deliberate daemon contract (no repeated id); the phone sends one.

Phone/Mac parity: rows 8, 9, 10, 12, 17 are phone-only code (viewer, outbox,
thumbnails, hub). Row 11's daemon refusal is the contract, and the TUI already
never sends a duplicate (`packages/tui/src/attach-files.ts` `collectAttachments`
skips an already-attached ref). No daemon/serve-side root.

## Implementation

*— claude-opus-5-5, 2026-11-20*

### Load-bearing assumption

The outbox can carry a photo with no ref and upload it itself at run time:
`OutboxPhoto.ref` is optional (`apps/mobile/src/outbox.ts:37-38`) and the
driver's `upload` loops over `pendingUploads` (photos with `ref === undefined`,
`outbox.ts` `pendingUploads`; `outbox-driver.ts:243-310`), recording each ref
before the prompt. Proved by the new compose test (the item's photo has no ref,
`runOutbox` → `port-upload` then `port-prompt`).

### Preconditions

- Offline, `attachImage` fails with a transport error that `refusalOf` maps to
  `{kind:"offline"}` (`outbox.ts:419-427`) — the simulator shows the chip go
  `uploading → refused` with the "no connection" notice, i.e. `uploadPicked`'s
  catch (`compose-controller.ts` `uploadPicked`).
- `takeChips` takes only `ready` chips and drops refused ones
  (`compose-chips.ts` `takeChips`) — that is where the photo was lost.
- History rows are built by `imageRef` with no local file
  (`transcript.ts` history/`user_message` paths); only `own_prompt` attaches
  `localUri` (`transcript.ts:263-276`). The screen's `ThumbnailSource` is not
  wired at all (`session-screen-controller.ts:796-797` falls back to
  `fetch: async () => null`; `createArtifactThumbnailSource` has no caller).
- The viewer's page is a zooming `ScrollView` whose content container has no
  height; the `Image` was `height: "100%"` of it (`MediaViewer.tsx`, before).

### Design

1. **Row 8** (`MediaViewer.tsx`): the pager measures its own height
   (`onLayout`) and each page + photo take that number; the scrim pads top and
   bottom by the safe-area insets (the same `useSafeAreaInsets` the
   `DiagramFullScreen` uses), so ✕ is below the status bar. Each photo gets
   `testID media-viewer-photo-<i>`.
2. **Rows 9/10** (`compose-chips.ts`, `compose-controller.ts`,
   `session-view.ts`): a new image chip state `waiting` — an upload that failed
   **offline** (or had no handle) is not refused; it is sent with the message,
   ref-less, and the outbox uploads it. `takeChips` takes `ready` + `waiting`;
   the button counts both (`sendable`), so a waiting chip also routes an online
   Send through the outbox run. A document chip is refused as before (its block
   is decided at attach).
3. **Row 12** (`sent-photos.ts`, `outbox-store.ts`, `App.tsx`): the outbox
   store keeps `sentPhotos: ref id → copy` (optional field, display-only,
   bounded to `KEEP_DISPLAY_COPIES` newest), harvested in `setItems` — the one
   write every send path goes through. `sentPhotoSource` answers the thumbnail
   port from it; `App.tsx` wires it as the session screen's `thumbnails`.
4. **Row 11** (`outbox.ts`): `refsOf` / `localPhotosOf` keep the first of each
   id — byte-identical photos are one content-addressed image, sent once.
   The screen asks the driver for the LIST's current rows (`listRows` ref +
   an effect on `rows`), see Execution drift 1.
5. **Row 17** (`floating-button.ts`, `SessionScreen.tsx`): `listEndPadding` —
   with the hub resting in the band's lower half, the list's bottom padding
   clears the hub's top edge.

### Files

`apps/mobile/src/{compose-chips,compose-controller,session-view,outbox,outbox-store,sent-photos(new),floating-button}.ts`,
`apps/mobile/src/screens/{transcript/MediaViewer,SessionScreen}.tsx`,
`apps/mobile/App.tsx`, `apps/mobile/e2e/flows/18-photos.yaml`; tests below.
No protocol, daemon or client change.

### Failure modes

- **Photo copy deleted before the outbox uploads it** → `readPhoto` throws →
  the driver's typed refusal (unchanged path), never a silent drop.
- **Waiting chip, link still down at Send** → the item is `waiting`, uploads
  on `up` (`link(up)` → `runOutbox`, fix/mobile-e2e-reds).
- **`sentPhotos` malformed / from an older build** → dropped on load, the
  outbox itself still loads (never set aside for a display index). An older
  build drops the unknown field on its next write: the photos fall back to
  the label, as before.
- **`sentPhotos` names a pruned copy** → the `Image` `onError` → `broken` →
  label (existing R2-1 path).
- **Lookup before the store loaded** → the source awaits `store.load()`
  (idempotent), so a first-frame miss is not recorded as a final failure.
- **Two identical photos, one uploaded and one waiting** → after the outbox's
  upload both refs are equal → `refsOf` sends one.
- **Pager height 0 on the first frame** → one frame without the photo, then
  the measured height.

### Tests

Red on the old code (shown), green after; mutation-checked:

- `compose-controller.test.ts` "a photo picked OFFLINE goes into the outbox
  item and up on reconnect" + "a waiting chip on a LIVE link sends through the
  outbox" — red: `Expected "waiting", Received "refused"` / `Expected to
  contain "port-upload:3", Received ["upload:4:a.jpg"]`.
- `outbox.test.ts` "two byte-identical photos name ONE ref" — red: refs
  `["a","a","b"]`.
- `sent-photos.test.ts` (new): indexed at `setItems`, survives the item AND a
  relaunch; the port answers a history ref; bounded; no churn; malformed
  dropped. Mutation (no `withSentPhotos` in `setItems`) → 1 fail.
- `mobile-media-live-wiring.test.ts`: viewer has a measured height and the
  safe-area top (red against HEAD's `MediaViewer.tsx`: 2 fail); `App.tsx`
  wires `sentPhotoSource` as `thumbnails`.
- `floating-button.test.ts` `listEndPadding` — mutation (plain padding) → red.
- e2e `18-photos`: after the send, open the first tile, wait for
  `media-viewer-photo-0`, tap ✕, wait for `media-viewer` gone.

## Execution

*— claude-opus-5-5, 2026-11-20*

Implemented in the order rows 9 → 11 → 12 → 8 → 17 (unit reds first, then one
Release build for the device check), then two device-found drifts:

**Drift 1 — row 12 had a second root (found on the device).** With the index
persisted (verified in the app container: `outbox-<hash>.json` →
`sentPhotos: {cb0501d6…: …/photos/…JPEG_fixture.jpeg, c414cd0e…: …PNG_fixture.png}`)
the tiles still drew labels after a relaunch. The thumbnail driver was never
asked: `SessionScreen.tsx`'s `onViewable` is a `useRef(...).current` callback
that read `state.transcript.rows` — the FIRST render's (empty) state, and the
wrong list (the FlatList's indexes are `state.view.rows`'). Fixed with a
`listRows` ref of the list's current rows, plus an effect that re-asks the
window when the rows change (a resync replaces them without a viewability
change). Guard test in `mobile-media-live-wiring.test.ts` (2 red on HEAD's
`SessionScreen.tsx`).

**Drift 2 — row 9 on the device: the upload had not failed yet at the tap.**
First device run: "PHOTO offline" reached the daemon with **0** images and the
next message ("TEXT offline") with **1** — the chip was still `uploading` when
Send later was tapped, so the F5/F6 rule ("an uploading chip joins the NEXT
message") moved it. Offline, an image chip still uploading is now taken with
the current message (`takeChips(chips, { pending: true })`, the send-later path
only); online the F5/F6 rule is unchanged. Test "Send later while the photo's
upload is still IN FLIGHT…" (red: `["PHOTO offline", 0]`).

**Drift 3 — viewer chrome colour.** With the photo drawn, the light theme's
label colour (black) made "1 of 2" and the caption unreadable on the black
scrim: fixed white text on the scrim (presentation only).

**Device verification** (own Release build of this branch, `run.ts --only
18-photos --hold`, iPhone 17 iOS 26):

| Row | Result |
|---|---|
| 8 | `18-photos` PASS with the new steps (`media-viewer-photo-0` visible, ✕ → `media-viewer` gone); by hand: page 2 draws the red fixture, "2 of 2", `media-viewer-photo-1` visible, ✕ closes |
| 9 | `stop-serve`, pick + Send later → dashed outbox row WITH the photo; `start-serve` → daemon history `'PHOTO offline' 1` image, "saw 1 image" |
| 10 | offline text → `outbox-row-…-waiting` + `waiting-network` ("Waiting for network · sent on reconnect if nothing changed"); sent on reconnect |
| 12 | background → foreground and `terminate` + relaunch: "PHOTO 2 tiles" and the outbox-sent "PHOTO offline" keep their pixels |
| 11 | two byte-identical JPEGs → history `'PHOTO dup' [one image/jpeg]`, turn ended ("saw 1 image"); before: `lost` in 5 ms |
| 17 | at rest at the end, the last row ("saw 1 image") ends above the hub |
| 13 | NOT VERIFIED: every simulator upload completes within a frame (no veil/% to see), and no upload refusal was producible |
| 14 | NOT VERIFIED (one attempt): the picker did not select a 5th photo in time (`chip-4-ready` never appeared) — same as the QA |

**Not fixed, noted:** a refused prompt (any `InvalidAttachment`) still reads as
a lost turn and loops on the decision sheet (row 11's secondary symptom); the
duplicate case can no longer reach it, but the classification is outbox
policy, left for a follow-up. The QA flow's second "Send later" on my run was
hidden under the keyboard (a flow artifact, not the app).

**Gate.** `bun run check` green (typecheck + lint clean, `bun test` 15731
pass · 0 fail · 5 skip — all opt-in: docker ×2, k8s, slow, live-docker). A
stray `{"resident":false}` line written into
`packages/tui/test/__snapshots__/diagram-lines.test.ts.snap` by the suite run
(an existing test's output, unrelated to this branch) was restored to HEAD's
content; worth its own look.

`scripts/e2e-gate.sh AF01E641-9EBC-4E39-B3C8-925DAE55807B` (Release build of
this branch, run dir `.tentacle/tmp/e2e-mobile/1795159092305`, exit 1):

```
flow                    result       seconds  tries
----------------------  -----------  -------  -----
01-shell                PASS         41       1
02-session-list         PASS         41       1
03-refresh              PASS         43       1
05-daemon-down          PASS         74       1
12-pair-declined        PASS         39       1
13-pair-expired         PASS         35       1
14-pair-bad-text        PASS         33       1
15-revoked              PASS         53       1
16-remove-computer      PASS         56       1
17-persisted            PASS         54       1
18-camera-denied        PASS         55       1
19-deep-link            PASS         26       1
20-camera-close         PASS         53       1
06-session-open         PASS         46       1
07-prompt               PASS         71       1
08-permission           PASS         61       1
08b-permission-deny     PASS         52       1
08c-permission-reply    FAIL         81       1
09-foreign-turn         PASS         51       1
10-background-ask       PASS         60       1
11-disconnect-mid-turn  PASS         52       1
12-steer                PASS         149      1
13-send-now             PASS         168      1
14-returned-mine        PASS         116      1
15-returned-other       PASS         45       1
16-offline-outbox       PASS         76       1
17-outbox-changed       PASS         56       1
18-photos               PASS         64       1
23-composer-keyboard    PASS         68       1
24-ui-shots             PASS         125      1
25-session-info         PASS         73       1
26-drawer               FAIL         80       1
27-activity             PASS         172      1
28-floating-activity    PASS         92       1
29-tool-rows            PASS         78       1
30-artifact-escape      PASS         52       1
31-chart-inline         PASS         74       1
32-chart-interact       PASS         62       1
33-hub                  PASS         235      1
34-hub-attach           PASS         48       1
34-hub-activity         PASS         57       1
34-hub-artifacts        PASS         47       1
34-hub-tools            PASS         46       1
34-hub-commands         PASS         46       1
34-hub-sessions         PASS         47       1
34-hub-info             PASS         48       1
34-hub-scheduled        PASS         59       1
34-hub-dictate          PASS         66       1
34-hub-new              PASS         57       1
18-lock-cold-start      PASS         47       1
19-lock-unlock-button   QUARANTINED  -        -
20-lock-immediately     PASS         49       1
21-export-logs          PASS         54       1
22-relay-only           PASS         76       1
push-placeholder        QUARANTINED  -        -
22-notify-render        QUARANTINED  -        -
22-notify-approve       QUARANTINED  -        -
22-notify-deny          QUARANTINED  -        -
22-notify-reply         QUARANTINED  -        -
22-notify-forged        QUARANTINED  -        -

GATE FAIL — 51 passed, 2 failed, 0 known-bug, 7 quarantined (of 60; 3607 s)
```

The two reds, classified (no NEW red vs main):
- `08c-permission-reply` — `Assertion is false: id: turn-idle is visible`
  (the failure screenshot: the permission sheet with the keyboard still up,
  the reply never sent). Fails alone too, and **fails identically on main's
  build** (the QA's 224d0f32 `tentacle.app`, `--app … --only
  08c-permission-reply`, run `1795163258773`): environment of this simulator
  (iPhone 17; the keyboard does not hide over the sheet), not this branch.
  The flow touches no code changed here.
- `26-drawer` — `session-rename-save` not found, right after the 08c red left
  its turn running ("Permission th… Running" in the drawer). **Passes alone**
  on the same build (`--only 08c-permission-reply,26-drawer`: 26-drawer PASS):
  a cascade of the 08c red.

## Review

*— pending (fresh context)*
