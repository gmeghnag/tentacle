# feat/mobile-push — end-to-end encrypted push through the mobile relay (APNs) + the daemon's grace rule (mobile task 16)

> **Status:** implementation APPROVED by the owner (2026-11-14)
> **Branch:** `feat/mobile-push` (this doc). Slices P0–P10 run **in order on this branch**, one commit per slice on the owner's OK, each gated by its narrow tests (AGENTS §4); the full gate before Review. **Starts only after task 15 (`feat/mobile-relay`) is merged**: P3, P4 and P8 build on its R1, R2 and R4/R5a.
> **Size:** L as a whole, split into S/M slices (table below) · **Blast:** load-bearing (a new hook in the session's `emit` path, a new method on the device principal, a new persisted file family under `devices/`, a secret on the relay host) · **Suited:** per AGENTS §10, P7 and P8 are `load-bearing` (strong executor + mandatory fresh-context Review red-teaming "a pod/relay is not trusted", "one session path", "don't serialize the RPC peer" and the steering no-await window). P0, P1, P3, P5, P6, P10 are S `contained`/`cross-module`; P2, P4, P9 are S–M. The owner assigns executors.
> **Changelog:** `changelog.d/mobile-push.added.md` (P8): `- **Push notifications for the mobile app, end-to-end encrypted.** When a permission request waits longer than \`push.graceSeconds\` (default 30 s) with nobody answering, or a turn ends while nobody is watching, \`serve\` pushes the paired phones through the mobile relay and APNs. Apple and the relay carry only an opaque blob, sealed to a per-device key and authenticated by the computer's key.`

## Context

*— claude-opus-5-5, 2026-11-14*

Mobile task 16 of `docs/eval/mobile-app.md` (decision 21, Phase 6). Today a
permission request that nobody answers waits silently: the daemon holds it
forever (by design, `packages/daemon/src/hosted-session.ts:22-31`), and a phone
only finds out when someone opens the app (`docs/feat/mobile-session-view.md`
F3: "push is task 16"). A turn that ends while you are away is also silent.

Binding decisions (linked, not copied):
- **Decision 8.** Push a permission request only if no device answers within a
  grace period (default 30 s, configurable), Time Sensitive. Push a turn's end
  or failure as a quiet notification grouped per session, and not when the app
  is open on that session. Nothing else. The content is **end-to-end
  encrypted**: Apple and the relay carry an opaque blob, and a Notification
  Service Extension (NSE) decrypts it with a key exchanged at pairing. The
  actions (Approve under Face ID, Deny, Reply, Open) are **task 17**.
- **Decision 2.** "One service, two uses: the same relay later carries APNs
  push."
- **Decision 9.** The relay runs on the site's box behind Caddy as
  `relay.tentacle.so`. The domain is never hard-coded in the app.
- **Decision 18.** No secret in the repo: "the APNs key lives only on the relay
  server".
- **Decision 19.** No third-party telemetry or services. So the app uses the
  raw APNs device token, never Expo's push service.
- **Decision 20.** Notification rules (including the grace period) live in pure
  modules under `bun test`. Push encryption is pinned by cross-language JSON
  vectors (the TS daemon encrypts, the Swift NSE decrypts in task 17). `xcrun
  simctl push` runs in Maestro E2E. Real push goes on the real-iPhone checklist.
- **Decision 14.** Approve from a notification always asks Face ID (task 17).
- Task 15 (`docs/feat/mobile-relay.md`, plan **not approved yet**; read from
  the `mobile-relay` worktree because `.tentacle/tmp/plans/mobile-relay.md`
  does not exist): one control socket per daemon (`/v1/daemon`, `hello` →
  `ready`), a self-certifying relay id, a stateless relay with "no persistence,
  no secret", the link dials only while ≥ 1 device is paired or a pairing window
  is open, and `relay.enabled` / `relay.url` / `--no-relay`. This task builds on
  that link. Conflicts are named in Preconditions and Owner Q6.

**Trust.** The relay is **not trusted**, in the spirit of AGENTS §7 "a pod is
not trusted". Apple's APNs is not trusted with content either. Either may read,
drop, delay, replay or forge anything it carries. Neither may learn the
content of a notification (project, session title, command, reply). Neither
may make the phone show a notification that looks authentic. Neither may make
an answer reach the daemon for a request the daemon did not raise. What they
can always do is accepted: drop pushes (push is best-effort anyway, and the ask
stays pending and is shown when the app opens), and see metadata (which relay
id pushes to which device token, when, and the uniform size).

**Deploy is NOT part of execution.** P10 writes the runbook additions. The
Apple Developer console steps (APNs key, capabilities) and the server steps
(**D2**, below) are separate steps the owner performs or explicitly approves.
No executor touches the server, Apple's console, DNS or Caddy.

**Repro (2026-11-14): the capability is missing, and the relay host can speak APNs's transport.**

1. Nothing push-related exists. Searching for `apns|push_register|devicePushToken|expo-notifications`
   in `{packages,apps/mobile}/**/*.{ts,tsx,json}` finds **No files found**. `apps/mobile/package.json`
   has no `expo-notifications` (its `expo-*` deps: build-properties, crypto,
   dev-client, file-system, image-manipulator, image-picker,
   local-authentication, screen-capture, secure-store).
2. APNs only accepts HTTP/2. Bun 1.4.3's `node:http2` **client** speaks it.
   Probe `.tentacle/tmp/mobile-push/h2-probe.ts`: a `node:http2` server and
   client in one Bun process, cleartext h2c. TLS was not possible here because
   generating a cert with `openssl` needed approval, so TLS + ALPN against
   Apple is P0(b). The probe sends APNs-shaped headers and a 3 KB body, gets
   back a 200 and a 410 `Unregistered`, and runs three concurrent streams on
   one session:

```
$ bun .tentacle/tmp/mobile-push/h2-probe.ts
alpn: h2c
200 apns-id=abc body=
410 apns-id=abc body={"reason":"Unregistered","timestamp":1}
200 apns-id=abc body= ; 200 apns-id=abc body= ; 200 apns-id=abc body=
POST /3/device/aaaa topic=so.tentacle.app type=alert auth=bearer eyJhbG len=3076
POST /3/device/dead topic=so.tentacle.app type=alert auth=bearer eyJhbG len=3076
POST /3/device/p1 topic=so.tentacle.app type=alert auth=bearer eyJhbG len=3076
POST /3/device/p2 topic=so.tentacle.app type=alert auth=bearer eyJhbG len=3076
POST /3/device/p3 topic=so.tentacle.app type=alert auth=bearer eyJhbG len=3076
```

(Script core: `http2.createServer()` plus `srv.on("stream")` answering
`:status` 200, or 410 + `{"reason":"Unregistered"}` for `/dead`;
`http2.connect("http://127.0.0.1:<port>")` plus `client.request({":method":"POST",
":path":"/3/device/<token>","apns-topic":…,"apns-push-type":"alert",
"apns-priority":"10",authorization:"bearer …"})`.)

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

**Everything the grace rule needs is already produced synchronously, in order,
at one point in the daemon: the session's `emit`. A daemon-internal observer
there, which is not an attachment, changes nothing that clients or the agent
loop see.** If this holds, push is one side-effect observer plus one transport
(the relay link). There is no second session path, no new decision by the
daemon, and no change to how an ask settles.

Proof:
- **An ask becomes visible at exactly one point.** `permission_request` is
  emitted only after it is durable, and only if it is still pending
  (`hosted-session.ts:913-925`: `ask.shown = true; this.emit(update)`).
- **Its end is also a single emit.** `settle` is first-wins (delete, then emit,
  then wake the gate) and emits `permission_resolved` for a shown ask
  (`hosted-session.ts:1136-1156`). A valid answer (`:1110-1134`) and the
  turn's abort (`registerAsk`'s `onAbort`, `:972-998`) both go through it.
- **The daemon never settles an ask itself.** "No timer, no socket event,
  nobody-attached ever settles it" (`hosted-session.ts:28-31`). So a grace
  timer can only *notify*. It can never race a daemon decision, and the ask
  outlives every push.
- **A turn's end is one emit, inside the no-await steering window.**
  `finishTurn` (`hosted-session.ts:2500-2545`) emits `turn_end` synchronously.
  An observer there must be O(1) and synchronous, and must never throw out.
  `emit` already runs `watchers.offer` under that same rule (`:1948-1963`).
- **The observer must NOT be an attachment.** `attachments.size` drives the
  blocking-ask fallback: `recheckAsks` denies a pending ask when no attached
  client can show it (`hosted-session.ts:1084-1097`, called from `attach`
  `:1580` and `detach` `:1590-1593`). It also drives the reaper, `session/list`
  and the model link. `watchers.ts:5-11` records exactly this reason for
  keeping followers apart. The push hook is therefore a plain callback in
  `emit`, outside both sets.
- **The daemon knows WHICH device each attachment is.** A connection carries
  `principal: {kind:"device", id}` (`packages/daemon/src/connection.ts:113-131`,
  `:159`, `:178`), and the `Attachment` is built in that same connection
  (`connection.ts:746-747`). So adding `deviceId` to `Attachment`
  (`hosted-session.ts:191-200`) is a local change.
- **The daemon holds the computer's static private key**, which is used to
  authenticate pushes as the sender (`packages/daemon/src/device-authority.ts:147`
  `staticKey()`, `:152` `identity()`, used by the device route at
  `packages/daemon/src/ws-server.ts:410-413`).

The parts NOT yet proved by execution are P0's blocking probes:
(a) noble-based HPKE matches the RFC 9180 test vectors;
(b) Bun's HTTP/2 client completes TLS + ALPN `h2` against
`api.sandbox.push.apple.com`;
(c) Bun WebCrypto signs an ES256 JWT that APNs accepts in format;
(d) the Expo SDK's `expo-notifications` returns the raw APNs token and writes
`aps-environment`.

### Preconditions

- **One `serve` per project store, and only a `serve` on the user's host has a
  device route.** `devices` is absent for pod daemons and the in-process worker
  (task 15 Preconditions, `ws-server.ts:54-68`). `startDaemon`
  (`packages/cli/src/serve.ts:193`) alone gives `SessionHost` a persister
  (`session-host.ts:208`, passed to each session at `:1091`). Push is wired at
  the same point, so **a pod never pushes, and never holds a token or a push
  key** (AGENTS §7: pod daemons store nothing durable, and a pod is not
  trusted).
- **The device store has ONE registry writer, the CLI**, under a lock
  (`device-store.ts:5-11`, `removeDevices` `:610-647`). A daemon writes only
  per-device files whose mtime or content is the record (`touchSeen`,
  `:656-671`). Push registrations follow the `seen/<id>` pattern: one file per
  device, written atomically by the daemon that received the registration.
  `registry.json` and `DEVICE_STORE_VERSION` are not touched.
- **Revoke closes a device's live sockets within one authority poll**
  (≤ 1 s, `device-authority.ts` poll, device-pairing F11). The authority's
  snapshot (`device-authority.ts:166-171`, `devices.has(id)`) is also the
  push-time check: a token file whose device is not in the snapshot is never
  pushed to.
- **The app attaches only to the session on screen.** One controller per
  computer; the screen opens on mount and detaches on leave
  (`apps/mobile/src/session-runtimes.ts:1-17`, mobile-session-view 12c). The
  foreground gate closes the socket on background
  (`apps/mobile/src/foreground-gate.ts`). So "this device is attached to
  session S" ≈ "the app is open, in the foreground, on S". This is decision 8's
  "app open on that session".
- **Protocol: additive only.** A new method is free: an older daemon answers
  `MethodNotFound` (AGENTS §7, "fields and methods are free"). No new
  `session/update` kind. So there is **no `PROTOCOL_VERSION` change and no
  `protocol.d/` note**. `protocol.json` is regenerated with `bun run
  schema:export` (`package.json:19`), as past method additions did. The merge's
  `protocol:bump` re-runs it.
- **The transport package already ships `@noble/ciphers`, `@noble/curves` and
  `@noble/hashes` 2.4.0** (`packages/transport/package.json:11-16`), behind a
  crypto subpath export (`"./noise"`, `:7-10`). Push crypto is a sibling subpath
  (`"./push"`), so the base client bundle does not grow.
- **Task 15 seams this plan uses (as planned, not yet built):** R1
  `packages/protocol/src/relay.ts` (control frames, zod strip schemas, "unknown
  `t` rejected"), R2 `apps/relay` (`relay-core.ts`, `server.ts`, "no
  persistence, no secret"), R4 `packages/daemon/src/relay-link.ts` (control
  socket, backoff, audit), and R5a's `relay.enabled` / `relay.url`.
  **Conflicts:**
  - **C1.** R1 rejects an unknown `t`, and an R2 relay closes the control socket
    on a frame it does not know. A daemon must therefore never send `push` to a
    relay that did not say it carries push. This needs a `features` array on
    `ready`, which is a strip-schema field, so an older daemon ignores it.
    It is cheapest folded into R1 before R1 executes (Owner Q6). If it is not,
    P3 adds it.
  - **C2.** R2/R7 say "no secret" on the relay. Push puts the APNs auth key
    (`.p8`) on the relay host. The relay stays stateless (no database), but it
    becomes a secret holder. R7's runbook and unit gain secret handling (P10).
  - **C3.** R4's link is event-only (`open` → accept). Push adds
    request/response on the control socket (`n` correlation + timeout), and
    a short hold queue while the link reconnects.
  - **C4.** R4 dials only while `wantsReachability()`. Push needs no change:
    a device with a push registration is a paired device, so the link is
    already wanted. No new dial condition.

### Design

**1. What is pushed, and when (pure `packages/daemon/src/push-rules.ts`, Owner Q3).**
The inputs are the hook's events plus the attached device set, with an
injected clock. The outputs are commands (`schedule`, `push`, `cancel`).
- **Ask (`permission_request` emitted, keyed by `requestId`).** Start a timer
  of `push.graceSeconds` (default 30; `0` = at once; range 0–3600). A repeat of
  the same `requestId` is ignored. This covers background-child re-offers at
  attach (`hosted-session.ts:1550`) and the replay to new attachments. At
  expiry, if the ask is still pending, push kind `ask` to every **registered**
  device (P5 file + present in the authority snapshot) that is **not attached
  to this session**. A device attached to the session shows the sheet. The
  devices pushed are remembered per `requestId`.
- **Ask settled (`permission_resolved`).** Before expiry: cancel the timer, and
  nothing is ever sent. This is "at the desk you answer and the phone stays
  silent". After a push: send kind `ask_resolved` to the devices that got the
  `ask`, with the **same collapse id**. APNs replaces the delivered banner, and
  task 17's NSE renders "answered on another device" (Owner Q3).
- **Turn end (`turn_end`).** `stopReason` = normal end → kind `turn_done`,
  `error` → `turn_failed`, `cancelled` → **nothing** (someone stopped it on
  purpose). Sent only when **no client of any kind is attached** to the session
  at that moment ("nobody is watching": a TUI at the desk silences it too,
  Owner Q3). It goes to every registered device. Grouping per session is done
  on the phone (`threadIdentifier`, set by the NSE: Design 3).
- **Session closed** (`session_closed`): drop the session's timers. Its asks
  were already settled `cancelled` → `ask_resolved` path.
- **Rate cap** (anti-storm, e.g. a model looping on asks): at most 1 `ask`
  push per session per 10 s per device. Later asks inside the window are
  folded into the next push ("+N more waiting"). The daemon also caps pushes at
  60/min overall. A refusal is an audit line, never silent. A real
  `ask_resolved` is never capped, so a stale banner is always replaced.
- Everything here is pure and table-tested. The I/O shell is
  `push-notifier.ts` (Design 5).

**2. Push crypto (`packages/transport/src/push-seal.ts`, subpath
`@tentacle/transport/push`, Owner Q1).** HPKE (RFC 9180), **Auth mode**,
suite DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305, single-shot:
- **Sender key = the computer's static key** (`staticKey()`). A push that
  opens is proven to come from the paired computer, because the NSE checks it
  against the computer key pinned at pairing. A relay or Apple cannot forge one.
- **Recipient key = a per-device push key**, an X25519 pair generated by the
  app at registration, kept in the Keychain under an access group the NSE
  shares (task 17). It is **separate from the Noise device key**, so the
  extension never holds the key that authenticates the device to the daemon.
  It also means no X25519 key is used in two protocols on the device side.
- `info = "tentacle-push/1"`, and `aad` = the envelope's key id (below).
  The plaintext is padded to the next bucket of 512 / 1024 / 2048 bytes, so
  every kind has one of three sizes. In practice a short `ask` and a
  `turn_done` are both 512 (metadata, Owner Q4).
- Why HPKE and not a one-way Noise pattern: iOS 17+ CryptoKit implements
  exactly this suite and mode natively (`HPKE.Recipient(…authenticatedBy:)`),
  so the NSE needs **no hand-written Swift crypto** (minimum target is 18,
  decision 12 superseded). RFC 9180 Appendix A.2.3 publishes test vectors for
  this exact suite + Auth mode. Those are decision 20's "spec vectors", and P0(a)
  is blocked on matching them.
- Vectors in the repo: `packages/transport/test/vectors/push-v1.json` holds
  (i) the RFC A.2.3 vectors, and (ii) our own envelope vectors (fixed keys +
  ephemeral seed → exact envelope bytes). Task 17's Swift tests read this same
  file.

**3. Wire formats (`@tentacle/protocol` `push.ts`, zod strip schemas, `v: 1`).**
- **Plaintext** `PushMessage`: `{ v:1, id (128-bit random, dedupe), at (ms),
  kind: "ask"|"ask_resolved"|"turn_done"|"turn_failed", computer: line(64),
  cwd: line(4096) (the app's project key, as in discovery,
  `protocol/src/daemon.ts:84-92`), sessionId, title: line(200),
  ask?: { requestId, tool, title: line(300), preview?: line(500), options:
  [{optionId, kind, name}], reply?: {maxChars}, more?: int },
  turn?: { turnId, error?: line(300) } }`. Every text field is clipped
  UTF-8-safely before sealing, so the envelope always fits APNs's 4096-byte
  payload. A sealing test asserts the worst case fits.
- **Envelope** (the APNs payload's custom key): `{ "tp": { v:1, k: <key id =
  b64url(SHA-256("tentacle-push-kid/1" ‖ computerPub))[0..11]>, e: <enc
  b64url>, c: <ciphertext b64url> } }`. `k` lets the NSE pick the pinned
  computer key among several paired computers. It links pushes to a computer,
  which the relay already knows via the relay id.
- **Outer `aps`**, built **by the relay from a fixed template** (the daemon
  cannot put plaintext in it): `{ alert: { title: "tentacle", body: "Open
  tentacle to see what's new" }, "mutable-content": 1, sound: "default" }`.
  Headers: `apns-push-type: alert`, `apns-priority: 10`, `apns-topic` = the
  relay's configured bundle id (`so.tentacle.app`, never daemon-supplied),
  `apns-expiration` = now + `ttl` (daemon-supplied, ≤ 86 400; the notifier
  uses 3600 for every kind), `apns-collapse-id` = daemon-supplied opaque
  random (≤ 64 bytes).
  **Uniform for every kind (Owner Q4):** interruption level (Time Sensitive for
  `ask`, passive for turns), sound and thread are set by task 17's NSE from the
  decrypted kind. Without an NSE (this task), every push shows the placeholder.
  If task 17's real-device check finds the NSE cannot raise
  `interruptionLevel` to Time Sensitive, the fallback is the relay adding
  `interruption-level` in clear for a daemon flag `urgent: true`. That leaks
  "ask vs turn" to Apple and the relay, and is recorded as such.
- **RPC** `device/push_register` (device principal only), params
  `{ token: hex 64–200, env: "sandbox"|"production", key: b64url 32 bytes }`,
  result `{ graceSeconds, push: "on"|"off"|"relay-off"|"relay-no-push" }`. The
  result lets the app say honestly why notifications will not arrive.
  `device/push_unregister {}` → `{}`. Both are refused for a `token` or
  `pairing` principal (the existing per-principal gate,
  `connection.ts:302-311`). Methods registry + `schema:export`. No bump.
- **Relay control frames** (amends R1, Owner Q6): `ready.features?: string[]`
  (`"push"` when the relay has an APNs key). Daemon → relay
  `{t:"push", n, token, env, collapse, ttl, payload: <envelope object>}`.
  Relay → daemon `{t:"push-result", n, status:
  "sent"|"gone"|"rejected"|"throttled"|"unavailable", reason?: line(64)}`. `n`
  is a per-socket counter, and responses can arrive out of order.
  `RELAY_PROTOCOL_VERSION` is unchanged: push is gated by `features`, so an R2
  relay never sees a `push` frame.

**4. Relay → APNs (`apps/relay/src/apns.ts` pure + `apns-client.ts`).**
- Config (flags/env, never in the repo): `--apns-key-file`, `--apns-key-id`,
  `--apns-team-id`, `--apns-topic`. If the key is missing or unreadable, `ready`
  has no `"push"` and the relay logs one line at start. The key is read once at
  start. Logs never contain the key, the JWT, a full token (8-char prefix
  only) or a payload.
- JWT ES256 (WebCrypto P-256, `kid`/`iss`/`iat`), cached and refreshed every
  40 min (Apple: no more than once per 20 min, valid ≤ 60 min).
- One HTTP/2 session per environment (`api.push.apple.com` /
  `api.sandbox.push.apple.com`, overridable for tests). It reconnects on
  GOAWAY/error. A request times out after 10 s → `unavailable`.
- Status mapping: 200 → `sent`. 410, or 400 `BadDeviceToken` /
  `DeviceTokenNotForTopic` → `gone` (the daemon deletes that registration).
  429 → `throttled`. Other 4xx → `rejected` + reason. 5xx/timeout →
  `unavailable`. 403 `ExpiredProviderToken` → refresh the JWT and retry once.
- Abuse limits (pure, in `relay-core.ts`, defaults overridable): per relay id
  120 pushes/min, **relay-wide** per device token 30/min (one token has one
  budget, whatever id pushes to it or reconnects), payload ≤ 4096 bytes after
  templating. A
  `push` from a socket that has not completed `hello` is refused (only a
  registered id may push, as only it may receive streams).

**5. Daemon (`push-notifier.ts`, `push-store.ts`, hook).**
- **Hook.** `HostedSession` gets an optional `onPushEvent(sessionId, update,
  attached: {devices: ReadonlySet<string>, clients: number})`. It is called
  from `emit` after `watchers.offer`, for `permission_request`,
  `permission_resolved`, `turn_end` and `session_closed` only. It is
  synchronous, wrapped in `try/catch` (a bug is reported, never thrown into the
  turn), and never awaited. `Attachment.deviceId?` is set by `Connection` from
  its principal. Absent option = today's behaviour exactly.
- **`PushNotifier`** (one per `serve`, given through `SessionHostOptions` like
  the persister; absent elsewhere). It feeds the hook into `push-rules`, owns
  the timers (an injected `setTimeout` for tests), and builds a `PushMessage`.
  Title is `titleText`, project is `cwd`, computer is `identity().name`. It
  seals it per device (P1) and hands `{token, env, collapse, ttl, payload}` to a
  `PushSink`. All the I/O starts after the hook returns (`queueMicrotask`), so
  the steering window stays await-free.
- **`push-store.ts`**: `<configDir>/devices/push/<deviceId>.json` =
  `{v:1, token, env, key, registeredAt}`, mode 0600. Write is tmp + rename. An
  unknown `v` or an unreadable file means that device is not pushed (one audit
  line), and the file is left untouched (AGENTS §7 on-disk rule). Delete on
  `gone` is compare-and-delete: only if the file's token still equals the one
  that failed, so a fresh re-registration is never deleted by a late `gone`.
  `removeDevices` (`device-store.ts:610`) removes `push/<id>.json` next to
  `seen/<id>`. `devices reset` empties `push/`. The notifier re-reads the
  directory at push time (it is small and rare) and filters by the authority
  snapshot.
- **`PushSink` = the relay link** (P8): `relayLink.push(frame) →
  Promise<status>`. It works when the link is `ready` with `"push"` in
  `features`. While the link is connecting it holds frames up to 60 s, then
  drops them with an audit line. Without `"push"` → `relay-no-push`, with one
  notice per start. With the relay disabled → `relay-off` (Owner Q2).
- **`device/push_register`** in `Connection`: validate, write the device's
  file, and answer the status. Concurrent registrations of the same device
  (two daemons, the same token): last rename wins, and both are identical
  anyway. Audit lines: `push-registered <id8>`, `push-sent <kind> <id8>`,
  `push-gone <id8>`, `push-dropped <reason>`, `push-capped`.

**6. Config & CLI.** `push.enabled` (default `true`) and `push.graceSeconds`
(default 30, 0–3600) in `packages/config` (`schema.ts`, `defaults.ts`,
`key-docs.ts`, `resolve.ts`), plus flag `serve --push-grace <seconds>`. Push
needs the relay link (Owner Q2). `--no-relay` / `relay.enabled=false` mean
**no contact with the relay at all**, so no push, and the register result says
`relay-off`. `tentacle devices` shows a `push` column (on / off), read from
`push/`.

**7. App (P9), with no notification UI beyond the OS placeholder (task 17 adds
the NSE and actions).**
- Add `expo-notifications` (only for permission + `getDevicePushTokenAsync`,
  the raw APNs token; never `getExpoPushTokenAsync`, decision 19). `app.json`:
  the plugin, `aps-environment`, a `keychain-access-groups` entry the NSE will
  share, and the Time Sensitive entitlement. **This needs a new dev build and
  provisioning** (owner, Apple console: D2a).
- Pure `push-registration.ts`. Per computer, register when `(token, env,
  pushKeyPublic)` differs from what was last registered with that computer
  (stored per computer in `computer-store`), on every successful connect. It
  unregisters on the Settings toggle-off. `MethodNotFound` → state `daemon too
  old` (shown in Settings, never retried in a loop). The `push` status from the
  result is shown in Settings.
- The push key pair is generated once (expo-crypto random → X25519 via
  `@noble/curves`, already a dependency) and stored with
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (`apps/mobile/src/secure-kv.ts:17`)
  under the shared access group. A token change (iOS may rotate it) triggers a
  re-register on the next connect.
- Ask for notification permission once, right after the **first successful
  pairing**, with one explainer line (decision 10: "asked only when needed and
  explained"). Settings gets a "Notifications" row (on/off + status), next to
  task 14's lock settings (Owner Q7).

### Slices

| id | scope | files | Size | Blast | deps |
|---|---|---|---|---|---|
| **P0** | Blocking probes, scratch only, results pasted into Execution. **(a)** HPKE Auth single-shot on `@noble/*` reproduces RFC 9180 A.2.3 (DHKEM X25519 / HKDF-SHA256 / ChaCha20-Poly1305) `enc`, shared secret, first ciphertext. **(b)** Bun `node:http2` TLS + ALPN `h2` to `api.sandbox.push.apple.com:443` with a bogus JWT → expect 403 `InvalidProviderToken` JSON (proves TLS/ALPN/framing against Apple; no secret needed). **(c)** WebCrypto ES256 JWT from a generated P-256 PKCS#8 key: header/claims, 64-byte r‖s signature, verifies. **(d)** `expo-notifications` version matching the app's Expo SDK: config plugin output (`aps-environment`), `getDevicePushTokenAsync` type = raw hex APNs token; CryptoKit HPKE availability (iOS 17+) from Apple docs | `.tentacle/tmp/mobile-push/*` only | S | contained | task 15 merged (for later slices) |
| **P1** | Push crypto: `sealPush(plaintext, senderStatic, recipientPub, rng)` / `openPush(...)`, padding buckets, key id; subpath export; vectors file | `packages/transport/src/push-seal.ts` (new), `packages/transport/package.json` (`"./push"` export), `packages/transport/test/push-seal.test.ts`, `packages/transport/test/vectors/push-v1.json` (new) | S | contained | P0 |
| **P2** | Protocol: `PushMessage` + envelope schemas, clip limits, `DEFAULT_PUSH_GRACE_SECONDS`, `device/push_register` / `device/push_unregister` (+ registry entries), `schema:export` | `packages/protocol/src/push.ts` (new), `packages/protocol/src/methods.ts`, `packages/protocol/src/index.ts`, `packages/protocol/schema/protocol.json` (regenerated), `packages/protocol/test/push.test.ts`, `packages/protocol/test/json-schema.test.ts` (samples) | S | cross-module | — |
| **P3** | Relay wire: `ready.features`, `push` / `push-result` frames (amends task 15's R1; skip `features` if R1 already has it) | `packages/protocol/src/relay.ts`, `packages/protocol/test/relay.test.ts` | S | contained | task 15 R1, P2 |
| **P4** | Relay APNs: pure `apns.ts` (JWT cache, request builder, status mapping, aps template) + `apns-client.ts` (http2 session per env, reconnect, timeout) + `relay-core.ts` push limits + `server.ts` handles `push` + flags; `features:["push"]` only with a readable key | `apps/relay/src/{apns.ts,apns-client.ts,relay-core.ts,server.ts,main.ts}`, `apps/relay/test/{apns.test.ts,apns-client.test.ts,server-push.test.ts}` | M | contained | P3, task 15 R2 |
| **P5** | Push registrations store: read/write/compare-and-delete; `removeDevices` + `devices reset` remove them; `devices` list column | `packages/daemon/src/push-store.ts` (new), `packages/daemon/src/device-store.ts` (`removeDevices` +2 lines), `packages/daemon/src/index.ts`, `packages/cli/src/devices-cmd.ts`, tests `packages/daemon/test/push-store.test.ts`, `packages/cli/test/devices-cmd.test.ts` | S | cross-module | P2 |
| **P6** | Pure rules: grace timers, exclusions, `ask_resolved` replacement, turn-end rule, folding/caps, collapse ids; injected clock | `packages/daemon/src/push-rules.ts` (new), `packages/daemon/test/push-rules.test.ts` | M | contained | P2 |
| **P7** | Daemon wiring: `onPushEvent` in `HostedSession.emit` + `Attachment.deviceId`; `SessionHostOptions.push`; `PushNotifier` (rules → seal → sink); `device/push_register` / `push_unregister` in `Connection`; audit lines | `packages/daemon/src/hosted-session.ts`, `packages/daemon/src/session-host.ts`, `packages/daemon/src/connection.ts`, `packages/daemon/src/push-notifier.ts` (new), `packages/daemon/src/index.ts`, tests `packages/daemon/test/push-notifier.test.ts`, `packages/daemon/test/push-hook.test.ts` | M | **load-bearing** | P1, P5, P6 |
| **P8** | `serve` wiring: config keys + docs + `--push-grace`; `relayLink.push` (correlation, 10 s timeout, 60 s hold, `features` gate) as the `PushSink`; `gone` → compare-and-delete; notices; changelog fragment. End-to-end bun test: phone over Noise registers → ask unanswered for the grace → the fake APNs receives one envelope that `openPush` opens with the device push key and the computer key | `packages/config/src/{schema.ts,defaults.ts,key-docs.ts,resolve.ts}`, `packages/daemon/src/relay-link.ts`, `packages/cli/src/serve.ts`, `packages/cli/src/main.ts`, tests `packages/daemon/test/relay-link-push.test.ts`, `packages/cli/test/serve-push.test.ts`, `changelog.d/mobile-push.added.md` | M | **load-bearing** | P3, P4, P7, task 15 R4/R5a |
| **P9** | App: `expo-notifications` dep + plugin + entitlements; push key (Keychain, shared access group); pure `push-registration.ts`; adapter; permission ask after first pairing; Settings row | `apps/mobile/package.json`, `apps/mobile/app.json`, `apps/mobile/src/push-registration.ts` (new), `apps/mobile/src/push-key.ts` (new), `apps/mobile/src/push-expo.ts` (new adapter), `apps/mobile/src/computer-store.ts` (last-registered hash), `apps/mobile/src/screens/SettingsScreen.tsx`, pairing-success hook in `apps/mobile/src/pairing-flow.ts`, tests `apps/mobile/test/push-registration.test.ts` | M | contained | P2 |
| **P10** | E2E + runbook: Maestro flow (pair → notifications allowed → `xcrun simctl push` with an envelope captured from P8's fake APNs → placeholder banner shown, tap opens the app); runbook additions to task 15's R7 (APNs key on host: systemd `LoadCredential`, file 0400, flags, rotation, rollback) | `apps/mobile/e2e/flows/push-placeholder.yaml` (new), `apps/mobile/e2e/run.ts`, `apps/relay/deploy/relay.service`, `docs/ops/relay-deploy.md` | S | contained | P8, P9 |
| **D2a** | **Owner, Apple Developer console** (not an executor slice): create the APNs Auth Key (.p8, key id), enable Push Notifications + Time Sensitive + keychain sharing for `so.tentacle.app`, regenerate profiles | none | — | account | before P9's device build |
| **D2** | **Owner-approved deploy**: install the `.p8` on 142.132.169.22 per P10's runbook, restart the relay with the APNs flags, smoke test | none in repo | — | production | task 15's D done, P0–P10 merged, owner OK |

Recommended serial order: P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 → P10.
P1, P2, P5 and P6 have no code dependency on task 15 and may run before it
merges, if the owner wants overlap (one branch at a time still holds: they ride
`feat/mobile-push`).

### Failure modes

| # | Case | Behaviour → how state converges |
|---|---|---|
| F1 | **Phone offline** (no network) when the push is sent | APNs stores the last push per collapse id until `apns-expiration` (1 h). After that it is lost, and the ask is still pending on the daemon, so the app shows it on open (decision 4). Never a lost decision: a push only notifies. |
| F2 | **Daemon offline / relay link down** at grace expiry | `PushSink` holds the frame ≤ 60 s for a reconnect, then drops it: `push-dropped link-down`. The ask stays pending. Audited, never silent. |
| F3 | **Relay down** | Same as F2. Direct paths still work for the app. The register result says `on` (the link will come back). Each attempt is audited. |
| F4 | **Relay without APNs key / old relay** (no `"push"` in `features`) | The daemon never sends `push` (C1). One notice per start. Register result `relay-no-push`, so the app shows "this computer's relay does not deliver notifications". |
| F5 | **Relay hostile: reads** | Sees the token, env, relay id, timing, and one of three sizes. Content is HPKE-sealed. Accepted (Trust). |
| F6 | **Relay or Apple hostile: forges a push** | Opening fails: Auth mode needs the computer's static key. Task 17's NSE shows only the placeholder for an unopenable push (it cannot suppress without Apple's filtering entitlement). It can carry no content and no action. |
| F7 | **Relay hostile: replays an old push** | The plaintext `id` is deduped by the NSE (seen-set in the app group), and `at` older than 24 h is discarded (task 17). An `ask` replayed after it was answered: Approve hits `PermissionNotPending` (`hosted-session.ts:1112-1117`). No effect. |
| F8 | **Relay hostile: drops / delays** | Undetectable by design (APNs gives no delivery receipt either). Bounded by `apns-expiration`. The pending ask is the source of truth. |
| F9 | **Relay hostile: tampers with `aps`** (alert text, removes `mutable-content`) | Without `mutable-content` the NSE does not run and iOS shows the relay's text. A malicious relay can show arbitrary text under the app's name, which it could do anyway with the APNs key. **No action is possible**: actions come from the category the NSE sets after a successful open (task 17). Recorded as accepted metadata/UX risk. |
| F10 | **Third party abuses the relay to spam a token** | It needs a registered relay id (any secret will do) AND the device token. The token only travels phone → paired daemon (inside Noise) → relay. Bounded by per-token 30/min (**relay-wide**: registering more ids or reconnecting one buys no extra budget) and per-id 120/min, and content is only placeholders. Accepted. |
| F11 | **APNs token rotates / app reinstalled** | The app re-registers on the next connect (hash differs). A stale token → APNs 410 → `gone` → compare-and-delete. Converges on the current token. |
| F12 | **Device push key rotation** | Re-register with the new key. The file is replaced atomically. Pushes sealed to the old key in flight fail to open (placeholder only). |
| F13 | **Computer identity reset** (`devices reset`) | The registry is emptied and `push/` too. No pushes. Phones re-pair and re-register (and the relay id rotates, task 15 Q5). |
| F14 | **Device revoked** | `removeDevices` deletes `push/<id>.json`. The push-time authority check also filters it within ≤ 1 s, even if a daemon re-wrote the file in a race (register on a socket that revoke is closing). |
| F15 | **APNs key rotation on the relay** (owner revokes/replaces `.p8`) | Runbook: install the new key, restart. In-flight requests fail `rejected`/`unavailable`. The daemon audits and drops (F2 path). JWT refresh every 40 min, and a forced refresh on `ExpiredProviderToken`. |
| F16 | **Version skew** | Old daemon + new app: `MethodNotFound` → Settings says "update tentacle on <computer>". New daemon + old app: never registers → no push. New daemon + old relay: F4. NSE older than the daemon's `v`/`kind`: placeholder (task 17). No `PROTOCOL_VERSION` move (additive). Unknown `push/<id>.json` `v`: that device is not pushed, the file is untouched, one audit line. |
| F17 | **App backgrounded** | The foreground gate closes the socket → detach → the device is no longer "attached". Pushes now reach it. Correct by construction: "attached" = foreground on that session. |
| F18 | **App killed** | The OS closes the socket (or the relay ping does). Same as F17. APNs delivery does not need the app running. The NSE runs on its own (task 17). |
| F19 | **Ask answered exactly at grace expiry** | `settle` and the timer callback both run on the event loop. Whichever runs first wins. If the timer ran first and pushed, the settle sends `ask_resolved` with the same collapse id, which replaces the banner. Never a stale actionable banner left behind. |
| F20 | **Many asks / a loop** | Folding plus caps (Design 1). At most one push per session per 10 s per device, with "+N more". `push-capped` is audited. |
| F21 | **Daemon restart with an ask pending** | Timers are not persisted. The reload re-asks (a new `requestId`, `docs/feat/suspended-turn-resume.md`), which starts a fresh grace and may push again. Accepted: a new ask is a new notification. |
| F22 | **Two daemons on one computer** | Each pushes only its own sessions' events, through its own relay link. Registrations are shared through `push/` (one file per device). |
| F23 | **Pod / in-process worker** | No `PushNotifier` (absent option) and no device route. Pinned by a test. A pod never sees a token. |
| F24 | **Hook throws / notifier bug** | Caught in `emit`'s wrapper and reported via `reportTurnError`. The fan-out and the turn are unaffected. Pinned by a mutation test (a throwing notifier, and the turn still ends). |
| F25 | **Disk full on `push_register`** | The write fails → RPC error `push-store-failed` → the app shows "could not enable notifications" and retries on the next connect. Nothing half-written (tmp + rename). |
| F26 | **Empty / invalid input** | Bad token hex, a wrong-length key, an unknown env → `InvalidParams`, and nothing is written. An oversized plaintext is impossible (clipped before sealing; a test asserts the bound). |

### §7 invariants touched

- **One session path:** push is an observer + a transport. It never answers
  an ask and never opens a second session path. Approve/Deny (task 17) go
  through the existing `session/resolve_permission` over Noise.
- **A pod / relay is not trusted:** content is sealed on the laptop, and the
  sender is authenticated by the computer key. The relay's `push-result` is
  input to validate (only `gone` has an effect, and only via
  compare-and-delete).
- **Single broker:** untouched. The hook observes the session, and the broker
  is not involved.
- **Don't serialize the RPC peer:** `device/push_register` takes no lock
  around `Connection`. The store write is a plain atomic rename.
- **Steering no-await window:** the hook is synchronous and O(1), and its I/O
  is deferred (`queueMicrotask`). The P7 test asserts nothing is awaited
  inside `finishTurn`.
- **Persistence:** `devices/push/<id>.json` is a new laptop-side, versioned
  file family in the trusted store. It is written only by a `serve` with a
  device route, never by a pod.
- **Never write raw to the terminal while Ink owns it:** `serve` has no Ink.
  Notices go through `onNotice` / `onAudit`.

### Tests

Red-first for every new behaviour. Each names its mutation (AGENTS §9).

Unit (`bun test`, in `bun run check`):
- **P1** RFC 9180 A.2.3 vectors (enc, shared secret, sequence-0 ciphertext)
  reproduced. Mutation: swap the `info` or skip `skS` in the KEM → fails.
  Envelope vectors are byte-exact. `openPush` with the wrong sender key → throws
  (mutation: Base mode instead of Auth → this test fails). Padding: lengths
  only in {512, 1024, 2048}. A flipped ciphertext byte → throws.
- **P2** schemas round-trip. Extra fields are stripped. A worst-case
  `PushMessage` (every field at its cap, 4-byte UTF-8 chars) sealed + enveloped
  + fixed `aps` ≤ 4096 bytes. Clipping never splits a surrogate pair.
- **P3** frames round-trip. An unknown `t` is still rejected. `features` absent
  ≡ `[]`.
- **P4** `apns.ts`: JWT claims and refresh boundary (39 min reuse, 40 min new,
  injected clock). Status table (200/400 BadDeviceToken/403
  Expired→retry-once/410/429/500/timeout). The aps template ignores any
  daemon-supplied `aps`. Topic from config only. `apns-client` against a local
  `node:http2` h2c fake APNs (the Repro's shape): concurrent streams, GOAWAY →
  reconnect, timeout → `unavailable`. `server-push`: `push` before `hello` →
  refused (mutation: drop the check → fails). Per-token and per-id limits at
  N / N+1. No key → `ready` without `"push"`. Captured logs contain no key, no
  JWT, no full token.
- **P5** write 0600 + read back. An unknown `v` → skipped, bytes unchanged.
  Compare-and-delete keeps a newer token (mutation: unconditional delete →
  fails). `removeDevices` removes `push/<id>.json`. `devices reset` empties it.
- **P6** rules (table-driven, injected clock): answered at 29.9 s → no push.
  Unanswered at 30 s → push to non-attached registered devices only (mutation:
  include attached → fails). Resolved after push → `ask_resolved`, same collapse
  id, only to the pushed devices. A re-offered `requestId` does not restart the
  timer. Grace `0` → immediate. Turn end with a TUI attached → nothing. Turn end
  with nobody attached → `turn_done`. `error` → `turn_failed`. `cancelled` →
  nothing. Session closed → timers cleared. Folding "+N" and the 60/min cap at
  the boundary. F19 ordering both ways.
- **P7** hook: a real `HostedSession` with a spy notifier sees exactly
  `permission_request` / `permission_resolved` / `turn_end` / `session_closed`,
  in emit order, with the right attached-device set. A throwing notifier → the
  turn still ends, other clients still get every update (F24). The notifier is
  not an attachment: with the notifier present and no client attached, a
  pending ask is NOT denied by `recheckAsks` (mutation: register it as an
  attachment → this fails). No await in `finishTurn` (spy records synchronous
  call order). `device/push_register` from a `token` principal → refused. From
  a device → file written. `PushNotifier` with a fake sink: the sealed envelope
  opens with the device key + computer key. A revoked device (absent from the
  snapshot, file still present) → not pushed.
- **P8** `relayLink.push` against task 15's R2 server + P4 with a fake APNs:
  `sent` / `gone` → file compare-deleted / timeout / held-then-dropped at 60 s
  (injected clock) / relay without `"push"` → no frame sent (mutation: ignore
  `features` → R2 closes the control socket and the test fails). **End-to-end:**
  phone (`noiseInitiator` + `RemoteClient`) pairs, registers, a mock-model turn
  asks permission, nobody answers for an injected 50 ms grace → the fake APNs
  gets one request whose envelope opens and names the right `requestId`.
  Answering within the grace → zero requests. `--no-relay` → result
  `relay-off`, zero requests. Config defaults/validation (`graceSeconds` -1 /
  3601 refused).
- **P9** `push-registration`: registers once per (token, env, key) per
  computer. A token change → re-register. `MethodNotFound` → `daemon too old`
  with no retry loop. Toggle-off → unregister. The permission prompt only after
  the first pairing success (pure decision).

Needs a real simulator, server or device (not in `bun test`; recorded in
Execution with dates):
- **Maestro (`bun run e2e:mobile`, mandatory before merge, P10):** pair, allow
  notifications, `xcrun simctl push` an envelope produced by P8's chain → the
  placeholder banner, tap opens the app on the computer. This proves the
  entitlements and plugin wiring, not APNs.
- **Real APNs (after D2a + D2, owner-approved):** a sandbox token from a
  dev build on the owner's iPhone, `serve` → `wss://relay.tentacle.so` → APNs
  → the banner within seconds. An unanswered ask → push after ~30 s; answered at
  the desk → silence. Answered on the TUI after the push → banner replaced. A
  reinstalled app → 410 → registration deleted.
- **Real iPhone (TestFlight checklist, decision 20):** a `production` token
  through a TestFlight build. Locked phone and Focus mode (Time Sensitive is
  verified in task 17 with the NSE). Phone offline for 2 h → the ask is shown on
  open.

### Owner questions

1. **Encryption: HPKE (RFC 9180) Auth mode, X25519 / HKDF-SHA256 /
   ChaCha20-Poly1305, sender = the computer's static key, recipient = a
   separate per-device push key the app generates at registration?**
   **Rec: yes.** CryptoKit decrypts it natively in the NSE (no hand-written
   Swift crypto), RFC 9180 publishes vectors for this exact suite + mode, a
   relay or Apple cannot forge a push, and the Noise device key never enters
   the extension.
2. **Push rides the relay's control socket; `--no-relay` / `relay.enabled=false`
   therefore also means no push; a custom relay without the owner's APNs key
   carries no push (the app says so)?** **Rec: yes.** One link and one opt-out
   that means "no contact with the relay". A separate `push.url` (custom relay
   for streams, tentacle.so for opaque pushes) is recorded as later debt.
3. **Rules: an ask is pushed after `push.graceSeconds` (daemon config, default
   30, 0 = at once) to devices not attached to that session; once answered
   elsewhere, a silent replacement push with the same collapse id; a turn end
   is pushed only when NO client is attached to the session (a TUI at the desk
   silences it); a cancelled turn is never pushed?** **Rec: yes.** It matches
   "at the desk the phone stays silent", and no actionable banner outlives its
   ask.
4. **A uniform outer payload for every kind (same `aps`, priority, TTL, size
   bucket); the NSE sets Time Sensitive / sound / thread from the decrypted
   kind; fall back to a clear `interruption-level` only if task 17's real
   device shows the NSE cannot raise it?** **Rec: yes.** Apple and the relay
   cannot tell an approval from a turn end.
5. **Push registrations live in per-device files `devices/push/<id>.json`
   written by the daemons (the `seen/<id>` pattern), not in `registry.json`
   (CLI-only writer)?** **Rec: yes.** No registry version bump, no second
   registry writer, and revoke deletes them.
6. **Task 15 conflicts: fold `ready.features` into R1 before R1 executes, and
   amend R2/R7's "no secret" (the relay holds the `.p8`, via systemd
   credentials)?** **Rec: yes.** One field now avoids an "unknown frame closes
   the control socket" trap later. P3/P10 cover it if task 15 has already
   executed.
7. **Scope split with task 17: task 16 delivers registration, rules, sealing,
   relay → APNs and the OS placeholder banner; the NSE decrypt, actions, Face ID
   and dedupe are task 17. The app asks notification permission once, right
   after the first successful pairing, with a Settings toggle?** **Rec: yes.**
8. **D2a/D2 are owner-only:** the Apple console steps (APNs key, Push / Time
   Sensitive / keychain-sharing capabilities) and installing the `.p8` on
   142.132.169.22. They happen after task 15's D and this task's merge, before
   the first TestFlight build. **Rec: yes.** No executor touches Apple's
   console or the server.

#### Owner decisions (2026-11-14)

All eight questions: the recommendation (owner: "Tutte come raccomandato").
Q6's amendment is recorded in docs/feat/mobile-relay.md before R1 executes.
Execution starts after task 15 (mobile-relay) is merged. *— claude-opus-5-5
(orchestrator), 2026-11-14*

## Execution

### P0 — blocking probes (all four PASS; scratch only in `.tentacle/tmp/mobile-push/`)

**Load-bearing check, re-run first.** Every `hosted-session.ts` citation the
Implementation's "Load-bearing assumption" rests on still resolves, and the
line numbers moved only slightly. **An ask becomes visible at exactly one
mechanism, `registerAsk` → emit:** the ordinary path marks `ask.shown = true` and
emits inside `persisted().then()` (`:933-935`), the background re-offer path marks
it then emits directly (`:1044-1047`), and both are after the ask is durable and
still pending. **Its end is one emit:** `settle` (`:1148`) looks up, deletes,
emits `permission_resolved` for a *shown* ask (`:1162`) and wakes the gate in a
`finally` — a valid answer and the turn's abort (`registerAsk`'s `onAbort`,
`:988`) both go through it, first-wins. **The fallback counts only attachments:**
`blockingUnsupported` returns `undefined` when `this.attachments.size === 0`
(`:1084`), so `recheckAsks` (`:1100`) — called from `attach` (`:1581`) and
`detach` (`:1604`) — cancels a pending ask only when an attached client *cannot*
show it; with no attachment the ask simply waits. **The emit path is synchronous
and already has a non-attachment observer slot:** `emit` (`:1960`) fans out to a
**copy** of `attachments` and then calls `this.watchers.offer(params)` (`:1974`);
`finishTurn` (`:2517`) sets state before the emit and reports a throwing sink
(`reportTurnError`, `:2502`), which is the no-await steering window the hook must
live in. **So the check passes:** a plain callback inserted after
`watchers.offer` is outside `attachments` (it cannot enter the ask fallback, the
reaper, `session/list` or the model link — `watchers.ts:5-11` records exactly
this reason), is synchronous, and cannot reorder a client's stream. The plan's
central assumption holds; P1 proceeds and no plan edit is needed. (The doc's
citations were off by ~15 lines — `emit` at `:1948` is really `:1960`,
`finishTurn`'s range `:2500-2545` really starts at `:2517` — the same code, so
this is drift in the numbers, not in the plan.) Nothing else in P0/P1 depends on
task 15.

**(a) HPKE Auth single-shot on `@noble/*` reproduces RFC 9180 A.2.3 — PASS.**
`.tentacle/tmp/mobile-push/probe-a-hpke.ts` re-derives the whole suite from the
RFC algorithm text (`LabeledExtract`/`LabeledExpand` with the **KEM** suite id in
`ExtractAndExpand`, AuthEncap's `DH(skE,pkR) ‖ DH(skS,pkR)`, the Auth key
schedule). Output:

```
PASS enc (=pkEm): f7674cc8cd7baa5872d1f33dbaffe3314239f6197ddf5ded1746760bfc847e0e
PASS pkSm (=x25519.getPublicKey(skSm)): f0f4f9e96c54aeed3f323de8534fffd7e0577e4ce269896716bcb95643c8712b
PASS shared_secret: d2d67828c8bc9fa661cf15a31b3ebf1febe0cafef7abfaaca580aaf6d471e3eb
PASS secret: 3022dfc0a81d6e09a2e6daeeb605bb1ebb9ac49535540d9a4c6560064a6c6da8
PASS key: b071fd1136680600eb447a845a967d35e9db20749cdf9ce098bcc4deef4b1356
PASS base_nonce: d20577dff16d7cea2c4bf780
PASS ct seq0: ab1a13c9d4f01a87ec3440dbd756e2677bd2ecf9df0ce7ed73869b98e00c09be111cb9fdf077347aeb88e61bdf
PASS shared_secret (receiver): d2d67828c8bc9fa661cf15a31b3ebf1febe0cafef7abfaaca580aaf6d471e3eb
PASS wrong sender key -> different shared secret
```

The probe also matched A.2.3's published `key_schedule_context`
(`probe-a2-kdf.ts`, PASS), which isolates the KDF from the KEM. Two bugs in my
*probe* were found and fixed by these vectors before any repo code existed
(noble's `hmac(hash, key, message)` argument order; the KEM's `"KEM"` suite-id
separator; Auth mode's two-part `dh`) — evidence the vectors do the work.

**(b) Bun `node:http2` TLS + ALPN `h2` to `api.sandbox.push.apple.com` — PASS.**
`probe-b-apns-h2.ts`, a bogus bearer JWT, no secret:

```
alpn: h2
status: 403 apns-id: 1B4A49C7-306F-6EAA-7E6C-42FF68D41D01
body: {"reason":"InvalidProviderToken"}
reason: InvalidProviderToken
PASS 403 InvalidProviderToken
```

So TLS, ALPN `h2`, the `POST /3/device/<token>` path, the APNs headers and the
`{"reason":…}` error framing all work from Bun — the exact 403 the plan predicted.

**(c) WebCrypto ES256 JWT from a generated P-256 PKCS#8 key — PASS.**
`probe-c-es256-jwt.ts`:

```
pkcs8 bytes: 138 import ok: true
signature length: 64 PASS 64-byte r||s (raw)
PASS verifies
PASS tampered input rejected
header: {"alg":"ES256","kid":"ABC123DEFG"} claims: {"iss":"TEAM123456","iat":1794685683}
PASS header/claims shape
```

Bun's `crypto.subtle.sign` returns the raw 64-byte `r‖s` APNs wants (not DER), and
a PKCS#8 `.p8` read off disk imports directly — so `--apns-key-file` needs no
conversion (P4).

**(d) `expo-notifications` for Expo SDK 58 + CryptoKit HPKE — PASS.** The app is
on `expo@58.0.17`; `expo-notifications` is dist-tagged `sdk-56: 56.0.26`,
`next: 58.1.4`, `latest: 58.1.9` and has **never** appeared in
`apps/mobile/package.json`. Its `plugin/build/withNotificationsIOS.js:54-56` sets
`config.modResults['aps-environment'] = mode` (mode defaults to `development`,
so P9 must pass the right mode per build); its
`src/getDevicePushTokenAsync.ts` returns `{type: Platform.OS, data}` where `data`
is `PushTokenManager.getDevicePushTokenAsync()`'s string, and iOS's
`ios/ExpoNotifications/Notifications/NotificationsAppDelegateSubscriber.swift:30-32`
hex-encodes the raw token (`data.map { String(format: "%02hhx", $0) }.joined()`) —
so `data` **is** the raw lowercase-hex APNs token, matching P2's `hex` schema,
with no Expo push service (decision 19). CryptoKit `HPKE` is `iOS 17.0+` (Apple's
own doc JSON: `introducedAt: 17.0`), so the app's iOS-18 minimum is covered and
`HPKE.Recipient(…authenticatedBy:)` is available to task 17's NSE.

The Context's repro re-ran unchanged: `rg -l 'apns|push_register|devicePushToken|expo-notifications' packages apps/mobile` → **no files**, i.e. the capability is
still absent.

### P1 — push crypto (DONE)

**Files.** `packages/transport/src/push-seal.ts` (new); `packages/transport/package.json`
(`"./push": "./src/push-seal.ts"`, beside `./noise` and `./relay-id`);
`packages/transport/test/push-seal.test.ts` (new, 24 tests);
`packages/transport/test/vectors/push-v1.json` (new);
`packages/transport/test/vectors/README.md` (a section for it).

**As built.** The module follows Design 2 exactly: `sealPush(plaintext, senderStatic,
recipientPub, rng)` / `openPush(sealed, recipientStatic, senderPub)`, `info =
"tentacle-push/1"`, `aad` = the key id, `u16` length prefix + zero padding to
512/1024/2048, and `pushKeyId(computerPub) = b64url(SHA-256("tentacle-push-kid/1" ‖
pk))[0..12]`. Pure and synchronous, randomness injected — the same shape as
`noise.ts`, which is why a vector can fix the ephemeral and compare bytes.

**Drift from the Implementation (one, deliberate, and additive).** The generic
HPKE Auth primitive is exported as `hpkeAuthSeal` / `hpkeAuthOpen` beside the
protocol-level `sealPush` / `openPush`. Reason: RFC 9180 A.2.3 addresses the bare
HPKE layer — it has its own `info` (`"Ode on a Grecian Urn"`), its own `aad`
(`"Count-0"`) and no tentacle padding — so driving it through `sealPush` would
mean widening `sealPush`'s signature for a test's benefit. The two thin wrappers
are then the only code that knows `PUSH_INFO`, the key-id `aad` and the padding,
so the RFC vectors and the envelope vectors each test exactly one layer. The
Design's public surface (`sealPush` / `openPush`) is unchanged.

**Two small additions the tests needed.** `PUSH_AEAD_TAG_BYTES = 16` (the sealed
`c` is the bucket **plus** the Poly1305 tag, i.e. 528/1040/2064 bytes — the
Implementation says "padded to 512/1024/2048", which is the *plaintext* padding;
the test asserts the exact wire sizes) and `maxPushPlaintextBytes()` (2046), so
the "worst case fits" bound P2 needs is a named function, not an expression in an
error string. `pushPaddedLength` and `publicKeyOf` are exported too.

**Vectors are independently generated.** `vectors/push-v1.json`'s `hpke` block is
RFC 9180 A.2.3 transcribed from `rfc-editor.org/rfc/rfc9180.txt`; its `tentacle`
block was produced by a **Python** HPKE Auth implementation written from the RFC
(`cryptography`: X25519 + HKDF-SHA256 + ChaCha20-Poly1305), which reproduces A.2.3
first and then emits our envelopes over fixed keys and a fixed ephemeral —
4 cases: empty, a 303-byte `ask`, a 197-byte `turn_done` (both 512), and a
2046-byte max (2048). The TS code never generated its own expectations.

**Red before green.** Every test was written against the module as it grew; the
two that the code initially failed are the ones the plan named — the byte-exact
envelopes (my `PUSH_PAD_BUCKETS`/tag assumption and a hex-vs-text helper mistake
were caught by the *vectors*, not by reading the code) and the "opens with the
pinned computer key" round-trip. The mutation table below is the non-vacuity
evidence (AGENTS §9), run with `.tentacle/tmp/mobile-push/mutations-p1.sh` plus
three follow-ups; each mutation is a one-line edit to `push-seal.ts`, restored
from a scratch backup (**never** git), then the file was diffed against the
backup to prove it came back identically.

| # | Mutation (one line) | Result | Tests that failed |
|---|---|---|---|
| 1 | `ExtractAndExpand` uses `HPKE_SUITE_ID` instead of `KEM_SUITE_ID` | RED | 5: A.2.3 enc/ct + all 4 envelope vectors |
| 2 | Auth → Base: drop `DH(skS,pkR)` from the sender's KEM `dh` | RED | 9 (A.2.3 secret, all envelopes, round-trips) |
| 3 | Base mode in **full** (drop `pkS` from `kem_context` too, seal+open) | RED | 6, **including "a relay's own key cannot open or forge"** — this mutation is why that test exists |
| 4 | `sealPush`'s `aad` → empty (key id no longer binds) | RED | 7 (all envelope bytes + round-trips) |
| 5 | `PUSH_INFO` → `"tentacle-push/2"` | RED | 5 (the constants test + all 4 envelopes) |
| 6 | `openPush` skips the key-id check | RED | 1: "an envelope naming another computer is refused" |
| 7 | padding bucket boundary `+1` | RED | 3 (boundary test, max-2048 vector) |
| 8 | `unpad` returns one byte short | RED | 6 (incl. "trailing zero bytes survive") |

Mutation 3 exposed a real weakness in my own test: the first version of the
forgery test passed under Base mode, because its throw came from the *key-id*
mismatch rather than from sender authentication. It now seals a forged envelope
with the relay's key over the exact `info`/`aad`/padding and asserts it does not
open — and it is RED under mutation 3, which is the property Design 2 relies on
("a relay or Apple cannot forge one").

**Failure modes covered by this slice.** F6 (a relay's key cannot open or forge —
mutation 3), F7's "replayed ask is inert" is P7's, F26's "an oversized plaintext
is impossible" (thrown, plus the 2046-byte envelope vector), a flipped ciphertext
byte → `bad-tag`, a flipped key id/`aad` → no open, an envelope naming another
computer → refused before decryption, a low-order recipient key → refused, a
wrong-size key → thrown. F12 (key rotation) is by construction: a re-registration
replaces the recipient key and old ciphertexts simply fail to open (placeholder).
**Corrected in fix round 1:** this paragraph originally listed "a flipped key
id/`aad` → no open" among the covered cases, and implied the padding was fully
pinned. The zero-tail case was in fact vacuous at the time (see Review round 1,
finding 1, and `### Fix round 1`).

**Gate (run in `.tentacle/worktrees/mobile-push`, this branch).**
`bunx tsc --noEmit` → clean; `bun run typecheck` (all three projects, incl.
`apps/mobile` + `apps/relay`) → clean; `bun run lint` → `Checked 1370 files … No
fixes applied` (baseline: clean, 0 errors, 0 warnings); `bun test` → **9903 pass,
4 skip, 0 fail** (9907 tests / 716 files). The 4 skips are the documented opt-in
ones (`TENTACLE_K8S_SERVER`, `TENTACLE_DOCKER_TESTS`, `TENTACLE_SLOW_TESTS`) —
this slice adds no skip. One full-suite run reported `1 fail` in
`packages/exec/test/confinement.test.ts` ("F2: a hard link …"); it is unrelated to
this slice (no touched file is imported there), it passed on the runs before and
after, it passes 3/3 when run alone (`46 pass 0 fail`), and the suite's next full
run was clean — a pre-existing flake in the confinement suite, recorded here
rather than claimed away. No schema changed, so `packages/protocol/schema/protocol.json`
is untouched. Changelog: one fragment, `changelog.d/mobile-push.added.md`;
`CHANGELOG.md` and `TODO.md` untouched.

**Not done, by instruction:** P2–P10 and D2a/D2 are untouched (P2's protocol
schemas, P3's relay frames, P4's APNs client, P5–P9, P10's runbook). No
`PROTOCOL_VERSION` change and no `protocol.d/` note — P1 adds no wire surface.

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 (executor), 2026-11-14*

### Fix round 1

**Findings addressed: 2 of 2 (both MEDIUM).** No HIGH was raised.

**Finding 1 (MEDIUM, vacuous padding test) — FIXED.**
Reproduced the reviewer's mutation first, on the test as it stood:
`padded[i] !== 0` → `=== 999` gave **24 pass / 0 fail**, i.e. the mutation
survived and the zero-tail loop was unpinned. Cause, exactly as the Review said:
the test sealed **510** bytes declaring 2, so `unpad` threw at the *bucket-length*
guard (`push-seal.ts:273-275`) and never reached the tail loop (`:281-283`).
The test now seals a **full 512-byte bucket** declaring 2 with the non-zero byte
at **index 511** — the last byte the tail loop can reach, so it pins the loop
bound as well as the comparison. Red before green, then green:

| State | Result |
|---|---|
| old test, mutation M1 | 24 pass / **0 fail** → survived (the bug) |
| new test, unmutated | 26 pass / 0 fail |
| new test, mutation M1 (`!== 0` → `=== 999`) | **1 fail**: "a non-zero padding byte is refused" |
| new test, mutation M4 (loop bound `− 1`) | **1 fail**: same test |

**Two more unpinned guards in the same class — also FIXED.** Probing finding 1's
class rather than its instance found both sibling `unpad` guards surviving:
M2 (length-prefix guard `if (false)`) and M3 (bucket-length guard deleted) each
left **26 pass / 0 fail**. Each now has one test that reaches exactly that guard
and no earlier one: "a declared length past the end of the bucket is refused"
(declared 511 in a 512 bucket, asserting `/length prefix exceeds the bucket/`)
and "a padded plaintext that is not exactly one bucket is refused" (a valid
envelope over a 4-byte padded body, asserting `/exactly one bucket/`). After the
tests, M1/M2/M3/M4 each fail exactly one test and nothing else:

| Mutation (one line) | Before these tests | After |
|---|---|---|
| M1 `padded[i] !== 0` → `=== 999` | survived (0 fail) | RED, 1 test |
| M2 length-prefix guard → `if (false)` | survived (0 fail) | RED, 1 test |
| M3 bucket-length guard deleted | survived (0 fail) | RED, 1 test |
| M4 tail-loop bound `i < padded.length − 1` | survived | RED, 1 test |
| M5 `PUSH_AEAD_TAG_BYTES` 16 → 12 | already RED | RED (unchanged) |
| M6 length prefix `i2osp2(plaintext.length)` → `i2osp2(0)` | already RED (6 tests) | RED (unchanged) |

Every mutation was applied to `push-seal.ts` in the worktree, run against only
`packages/transport/test/push-seal.test.ts`, and restored from a scratch backup
under `.tentacle/tmp/mobile-push/fix1/` (**never** git); each restore was
`diff`ed against the backup and reported identical.

**Finding 2 (MEDIUM, attribution) — FIXED.** The Execution was signed
`claude-opus-5-5 (executor)`, but the executor is `ds()`
(`.tentacle/tmp/orchestration/night-task.sh:17`), which runs
`~/bin/tentacle --profile deepseek` → `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`
(`~/.config/tentacle/config.jsonc:25-33`); only `opus()` uses `--model
claude-opus-5-5` (`:13`). The executor's transcript shows how the wrong id got
there: it grepped **the orchestrator's** Claude session jsonl
(`~/.claude/projects/-Users-gmeghnag-tentacle/232c4c3e-….jsonl`, 2704 ×
`claude-opus-5-5`) and signed itself with the answer. The signature now names the
real model. **Drift from the Review's recommendation:** the Review said "the owner
or orchestrator must correct one of the two"; I corrected the doc, because the
commit message and the launch command already agree (`feat(mobile-push): exec
(deepseek)`), so the signature was the one wrong artifact — and no rebase/amend
was available to me (no git checkout/commit).

**Nits taken (all four, none blocking).** (a) `push-seal.test.ts:68`'s "quick
brown fox" comment corrected to "Ode on a Grecian Urn", and the `info` is now
asserted as text rather than only as hex. (b) The test named "receiver derives the
published shared secret" is renamed to "the envelope authenticates the sender's
static key (Auth, not Base)", and its comment now states that `shared_secret` is
pinned *indirectly* by the byte-exact `ct` — the honest claim. (c) The changelog
fragment no longer credits the NSE (task 17) with opening pushes; it says the
envelope is openable by CryptoKit and that the extension is the app-side task.
(d) `SealedPush.ciphertext`'s comment now says `bucket + 16` = 528/1040/2064, not
512/1024/2048.

**Gate (this worktree, this branch).** `bunx tsc --noEmit` → clean, exit 0;
`bun run typecheck` (all three projects) → clean, exit 0; `bun run lint` →
`Checked 1370 files in 399ms. No fixes applied.` (baseline clean, exit 0);
`bun test` → **9905 pass, 4 skip, 0 fail, 716 files** on four of the six full
runs I made, with `1 fail` on two. The 4 skips are the documented opt-ins; this
round adds none. **Both failures named, not hidden — neither is this branch's:**

1. `packages/daemon/test/session-log-store.test.ts` — "T4 the fork precedes the
   source's next write" (captured: `gate3.log`). A timing test that gates on
   `await Bun.sleep(60)` (`:857`). That file is **not** in
   `git diff --name-only main...HEAD`, imports nothing from `@tentacle/transport`,
   and passes **45/45 three times in a row** when run alone. Under full-suite
   parallel load it loses the race.
2. An earlier run reported only a 5000 ms timeout whose stdout was
   `{"resident":false}` — the fixture of the cli engine tests
   (`engine-runtime.test.ts:186`, `engine-docker.test.ts:225`). Those two files
   then passed 144/144 three times running.

My only non-test source change this round is a **doc comment**, which no daemon
or cli test imports, so neither failure can be mine. **Unverified:** I did not run
`bun test` on `main` at the same commit to prove both flakes pre-date this branch
— the evidence is that they are outside the branch's diff and only fail under
load. To verify, run `bun test` a few times on a clean `main` worktree.

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 (executor, fix round 1), 2026-11-14*

### P2 + P3 — protocol: push wire + relay frames (DONE)

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 (executor, P2 + P3), 2026-11-14*

**Load-bearing check, re-run first: PASS.** Every `hosted-session.ts` citation
still resolves, at the line numbers the P0 run recorded. `blockingUnsupported`
returns `undefined` when `this.attachments.size === 0` (`:1084`); `recheckAsks`
(`:1100`) is called from `attach` (`:1581`) and `detach` (`:1604`); `emit`
(`:1960`) fans out to a copy of `attachments` and then calls
`this.watchers.offer(params)` (`:1974`); `settle` (`:1148`) deletes, emits
`permission_resolved` for a shown ask, and wakes the gate in a `finally`;
`finishTurn` (`:2517`) sets state before its emit. Unchanged since P0, so the
plan's central assumption holds and P2/P3 (pure protocol, which touch none of
it) were implemented as written.

**Files.** `packages/protocol/src/push.ts` (new, the whole P2 wire);
`packages/protocol/src/methods.ts` (`Method.DevicePushRegister`,
`Method.DevicePushUnregister` + their two registry entries);
`packages/protocol/src/index.ts` (`export * from "./push.ts"`);
`packages/protocol/schema/protocol.json` (regenerated, not hand-edited);
`packages/protocol/test/push.test.ts` (new, 15 tests);
`packages/protocol/test/json-schema.test.ts` (4 fixture entries — the export's
"every method has a fixture" gate); `packages/protocol/src/relay.ts` (`push` /
`push-result` frames + their schemas in all three unions, and the shared
`RelayPushTokenSchema` / `RelayCollapseIdSchema`);
`packages/protocol/test/relay.test.ts` (a new `describe("push frames")`, 9 tests);
`changelog.d/mobile-push-protocol.added.md` (new).

**P3 is smaller than planned, because R1 already stores what it needed.** The
slice's own text allows this ("`ready.features` … skip `features` if R1 already
has it"): task 15 shipped `features` on `ready` **and** `knownRelayFeatures` /
`isRelayFeature` with `"push"` already in `RELAY_FEATURES`
(`relay.ts:196-238`). So P3 adds only the two frames and the schemas that gate
them. No `RELAY_PROTOCOL_VERSION` move: a `push` is gated by `features`, so an
R2 relay never sees one.

**Drift from the Implementation, and why.**
1. **`fitPushMessage` is new, and it is the load-bearing addition of this
   slice.** The plan said the schema's per-field caps plus "clip before
   sealing" keep a push inside 4096 bytes; they do not — a worst-case message
   with every field at its cap is ~14 KiB of UTF-8, which no 2048-byte bucket
   can hold. So the wire gained one producer-side gate: `fitPushMessage`
   returns the encoded plaintext, clipping through a 9-rung ladder (preview
   first, ids last) until it fits `PUSH_PLAINTEXT_MAX_BYTES`. The plan's
   worst-case test is therefore a property of the CODE, not of a comment.
   `clipPushText` walks code points and drops lone surrogates and control
   characters, so a clip can never produce something Swift's decoder refuses.
2. **`PushEnvelope.c` is a regex alternation, not `.refine()`.** The exporter
   rejects `ZodEffects` (`json-schema.ts`'s `SUPPORTED_KINDS`), and this
   schema is on the exported wire, so the three-length bound had to be a plain
   string constraint (`PUSH_CIPHERTEXT_RE`, pinned by
   `PUSH_ENVELOPE_CIPHERTEXT_LENGTHS`).
3. **`push-result.status` is a bounded FREE string, not the five-value enum.**
   Same reason R1's review fixed `error.code` (`relay.ts:257-273`): a closed
   enum makes a newer relay's new status a "malformed frame", which closes the
   whole control socket — one unknown word would cost every push in flight and
   the link's reachability with it. The daemon refuses the VALUE through P2's
   `isPushDeliveryStatus`, so an unknown status drops one push. Pinned by a
   dedicated test (mutation M7 below).
4. **The token rule is written twice** (`PUSH_TOKEN_RE` in `push.ts`,
   `RelayPushTokenSchema` in `relay.ts`) because the relay must not load the
   RPC schemas. A test pins the two against one shared sample, so the
   duplication cannot drift silently (mutation M9).
5. **No `relayPushFrameOf` builder.** I drafted one, then dropped it: the
   daemon's relay link (P8) owns `n`, the timeout and the `features` gate, and a
   builder here would have been an unused second seam. The frames are plain
   objects validated by their schemas.
6. **`PUSH_PAD_BUCKETS` is declared in `push.ts`, not imported from
   `push-seal.ts`** — the dependency runs transport → protocol, so importing it
   would be a cycle. The duplication is pinned by a test
   (`PUSH_PLAINTEXT_MAX_BYTES === maxPushPlaintextBytes()`), which is a stronger
   guarantee than a comment.
7. **The changelog is `changelog.d/mobile-push-protocol.added.md`, not
   `mobile-push.added.md`.** One bullet per file is enforced by
   `scripts/changelog.ts:120`; P1 already owns `mobile-push.added.md`, so a
   second bullet there fails the guard (I hit exactly this in the first full
   gate run, and split it).

**Red before green.** `bun test packages/protocol/test/push.test.ts` on the
unimplemented tree: `SyntaxError: Export named 'DEFAULT_PUSH_GRACE_SECONDS' not
found` — 0 pass, 1 error. `bun test packages/protocol/test/relay.test.ts` after
the P3 test and before the frames: `Export named 'RelayCollapseIdSchema' not
found` — 0 pass, 1 error. Both are the assertion-bearing tests of the property
(missing capability), not an incidental import typo: the exports are exactly the
capability the slice adds.

**Mutations (§9 non-vacuity — each applied to `src`, run, reverted; `git diff`
empty afterwards, backups in `.tentacle/tmp/mobile-push/`):**

| # | mutation | result |
|---|---|---|
| M1 | `clipPushText` cuts by UTF-16 `slice` instead of code points | **RED** "clipPushText cuts on code-point boundaries" (14 pass / 1 fail) |
| M2 | `fitPushMessage` returns the message unclipped | **RED** (whole file fails: the thrown oversize error) |
| M3 | `PushPayloadSchema` gains an `aps` field | **RED** "the payload is `{tp}`, and an `aps` … is STRIPPED" |
| M4 | the register result's `graceSeconds` loses its 0..3600 bound | **RED** "the result says WHY, and the grace the daemon uses" |
| M5 | `PUSH_TOKEN_RE` loosened to `/^.{64,200}$/` | **RED** "a bad token, env or key is InvalidParams" |
| M6 | `push` dropped from `RelayControlFrameSchema` | **RED** "daemon → relay `push` round-trips through both unions" |
| M7 | `push-result.status` becomes a closed 5-value enum | **RED** "an unknown `status` PARSES but is not a known one" |
| M8 | `push`'s `payload` gains `aps` | **RED** "an unknown field is stripped; `aps` … NOT fields at all" (after M8 first SURVIVED — see below) |
| M9 | `RelayPushTokenSchema` loosened to `/^.{64,200}$/` | **RED** "every field is validated" + "the token and collapse-id schemas agree" |
| M10 | `pushCollapseIdOf` ignores its `key` | **RED** "a collapse id is opaque, header-safe and ≤ 64 bytes" |
| M11 | `pushCollapseIdOf` does not truncate to 64 | **RED** same test + "every field is validated" |

**M8 first SURVIVED, and that is the useful result: the test was weak.** It
sent `aps` at the frame's top level only — the tempting place is
*inside* `payload`, which is exactly where an APNs payload keeps its banner
text. Strengthened to assert both levels; the mutation now goes RED. (M9's
survival on its own was the same class: only a dedicated cross-layer test made
it bite.)

**Gate (this worktree, this branch).** `bunx tsc --noEmit` → clean, exit 0.
`bun run lint` → `Checked 1372 files in 397ms. No fixes applied.` (baseline
clean, exit 0). `bun run schema:export` → regenerated `protocol.json` (never
hand-edited). `bun test` → **9930 pass, 4 skip, 0 fail, 717 files**. The 4 skips
are the documented opt-ins (live-k8s, live-docker, the ~12 s real-socket
keepalive, and `confinement.test.ts`'s root-only case); this round adds none —
checked with `rg 'test\.skip|\.skipIf'` and by running those three files alone
(46 pass / 2 skip).

**Unverified:** P8's end-to-end proof (a sealed envelope actually reaching a
fake APNs through the relay link) and P4's `aps` template are other slices; the
4096-byte joint bound here is pinned with the template inlined as a literal, so
if P4's template differs in size that test must be re-derived against it.

## Review

### P0 + P1 (scope: `git diff main...HEAD`)

**Verdict: REQUEST-CHANGES** (one MEDIUM test-vacuity finding, one MEDIUM process finding; the crypto itself holds).

**Findings**
1. **MEDIUM: the test "a non-zero padding byte is refused" is vacuous** (`packages/transport/test/push-seal.test.ts:343-369`). It seals a **510-byte** plaintext, so `unpad` throws `bad-padding` at the bucket-length check (`push-seal.ts:273-275`) and never reaches the zero-tail loop (`push-seal.ts:281-283`). Mutation `padded[i] !== 0` → `=== 999` (the tail check turned off): **24/24 still pass**. So the property is unpinned, and a sealer bug that leaves bytes after the declared length would open silently. Fix: seal exactly 512 bytes (declared length 2, non-zero tail), then confirm RED under the same mutation. This violates AGENTS §9, which is mandatory, and the Execution claims this case is covered.
2. **MEDIUM (process): the executor attribution conflicts.** Commit `f33ef6d6` reads `feat(mobile-push): exec (deepseek)`, but the Execution section is signed `claude-opus-5-5 (executor)`. AGENTS §10 requires the signature to name the model that actually wrote the section (that is how routing and drift are tracked). The owner or orchestrator must correct one of the two.

**Gate (narrow, as scoped):** `bun test packages/transport/test/push-seal.test.ts` gave 24 pass / 0 fail. `bun run lint` checked 1370 files with no fixes. `bun run typecheck` (all 3 projects) was clean. I did not re-run the full `bun test`, because it was out of the requested scope.

**Premises:** all TRUE.
- The RFC 9180 A.2.3 block in `push-v1.json` (skEm, pkEm, skRm, pkRm, skSm, pkSm, enc, shared_secret, key, base_nonce, pt, ct, info) appears verbatim in `rfc9180.txt`, checked with a scratch script.
- The `tentacle` block's generator (`gen-vectors.py`) imports only `hashlib`/`hmac` and `cryptography`, with no TS and no subprocess, so the vectors really are independent.
- `./push` is exported in `packages/transport/package.json`.

**Mutations (reviewer, restored from a scratch backup, `git diff` empty afterwards):**
- M-a: zero-tail check off → **survived** (finding 1).
- M-c: explicit low-order `acc === 0` check off → survived. This is benign: noble's `getSharedSecret` already throws on that input, and `dh`'s catch maps it to `bad-key`, so the boundary behaviour is still pinned.
- The executor's table (KEM suite id, Base mode, aad, info, key-id check, bucket boundary, unpad) is consistent with the tests as read.

**Attacks tried**
- (i) Forgery under Base mode: the forged-envelope test (`:239-264`) seals with a different static key over the exact info/aad/padding. It holds.
- (ii) Moving a ciphertext to another computer: the key id is both the `aad` and a pre-decrypt check. It holds.
- (iii) Bucket and length leakage: `c` is always bucket + 16 (528/1040/2064). It holds. `SealedPush.ciphertext`'s doc comment (`push-seal.ts:84`) still says 512/1024/2048 (nit).
- (iv) Truncated or oversized input: oversized is thrown, never truncated. It holds.

**§7:** "a relay is not trusted" is upheld for this layer: sender authentication comes from the Auth KEM and is proven by a test. No wire, persistence or terminal path is touched.

**Nits (not blocking):**
- `push-seal.test.ts:68`: the comment says the A.2.3 info is "The quick brown fox", but it is "Ode on a Grecian Urn".
- The test named "receiver derives the published shared secret" never compares `shared_secret`. The `ct` match implies it.
- The changelog fragment credits the NSE (task 17) with opening pushes.

**Executor behaviour:** careful and honest about its own weak test (mutation 3), and it used independent oracles. However, it missed that its padding test fails for the wrong reason, which is the same class of mistake it caught in mutation 3.

*Reviewed by the same model family named in the Execution signature (fresh context only). Shared blind spots are possible.*

*— claude-opus-5-5, 2026-11-14*

### Round 2

**Verdict: PASS** (scope: `git diff HEAD~1`, commit `0e03b0f6`).

1. **Finding 1 (vacuous padding test): fixed.** The test now seals a full 512-byte bucket that declares a length of 2 and ends in `0xff`, and the executor added one test per `unpad` guard. Reviewer mutations, each restored from a scratch backup:
   - tail loop `!== 0` → `=== 999`: **RED** ("non-zero padding byte").
   - tail-loop bound `padded.length - 1`: **RED** (same test, because the last byte is the one that is non-zero).
   - length guard disabled (`+ 999`): **RED** ("declared length past the end").
   - bucket guard disabled (`=== 999`): **RED** ("not exactly one bucket").
   After the restores, `git diff` is empty.
2. **Finding 2 (attribution): fixed.** The Execution and the fix round are now signed `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`. My round-1 footer ("same model family") is therefore wrong: this review is by a **different** model family from the executor, which is the routing AGENTS §10 wants for load-bearing work.
3. **Nits:** all addressed.
   - The A.2.3 `info` comment is corrected, and the test now asserts the decoded "Ode on a Grecian Urn" string.
   - The shared-secret test is renamed to what it actually proves.
   - `SealedPush.ciphertext`'s doc now says 528/1040/2064.
   - The changelog no longer credits a not-yet-built extension.

**Regressions:**
- The only change in `src` is a comment.
- `bun test packages/transport/test/push-seal.test.ts` gives 26 pass / 0 fail (24 before, plus 2 new tests).
- `bun run lint` checked 1370 files with no fixes.
- `bun run typecheck` (all 3 projects) is clean.

*— claude-opus-5-5, 2026-11-14*


### Review — P2 + P3 (fresh context)

**Verdict: APPROVE-WITH-NITS** (no HIGH/MEDIUM finding; scope `git diff main...HEAD`, slices P2 + P3 only).

**Gate (narrow).** `bun test` push/relay/json-schema/version tests: 78 pass / 0 fail. `bun run lint`: clean (1372 files). `bun run typecheck` (root + mobile + relay): clean.

**Attacks tried.**
1. *Ladder truncates ids* — `fitPushMessage` rungs 7–9 clip `sessionId` (32/16 B), `requestId` (24 B) and `optionId` (16 B), which would point a push at a wrong session or ask without any error. Probe (`.tentacle/tmp/mobile-push/ladder.ts`: every field at its cap, as `"` (JSON doubles them) and as 4-byte emoji, 8 options, real UUIDs) never got past rung 6: max 2012 B, ids intact, output passes `PushMessageSchema`. Unreachable with daemon-made UUIDs → nit N1, not a finding.
2. *A `push` reaching an R2 relay / a `push-result` reaching an R4 daemon* — `server.ts:395` still closes on `push` (`control-unexpected`). `relay-link.ts` ignores a parsed `push-result` (it falls through). Both are gated by `ready.features` (P8). No regression.
3. *Frame size* — the worst push frame is about 3.1 Ki chars, far below `RELAY_CONTROL_LIMITS.maxFrameChars` (96 Ki). No oversize close.
4. *Strict vs strip / forward compat* — every new payload is a strip object. `push-result.status` is a free bounded string, refused by value (`isPushDeliveryStatus`). Matches the v10 rule.
5. *Mutation non-vacuity* — this session's permissions blocked my own mutation runs (the in-place edit script). Static check instead: tests pin the ciphertext length (`push.test.ts:238,242`, `relay.test.ts:564`), the ttl bounds (`relay.test.ts:554-557`) and control-char clipping (`push.test.ts:118`). The executor's M1–M10 table is accepted but **not re-run by me**. To verify: run `.tentacle/tmp/mobile-push/rv3-mut.sh` from the worktree root.

**Nits (LOW).**
- N1 `packages/protocol/src/push.ts:405-440` (rungs 8–9): clipping an id gives a *wrong* id, not a shorter one. Better to fail loud (throw, or drop `ask`) than to clip `requestId`/`sessionId`/`optionId`.
- N2 `packages/protocol/src/relay.ts:295-300` gives a false reason for duplicating the token regex ("the relay must not load the RPC schemas"). `relay.ts` now imports `push.ts`, and `apps/relay` imports the whole `@tentacle/protocol` index (`server.ts:31`). The pin test holds, so the duplication is harmless, but the comment is wrong.
- N3 `packages/protocol/test/push.test.ts:193`: `APS.slice(7)` keeps the outer `}`, so `body` is not valid JSON. It is one byte over, so the ≤ 4096 bound still holds, but the check would be stronger with `JSON.parse(body)`.

**Executor behaviour.** The drift is documented honestly and justified (`fitPushMessage`, the regex instead of `.refine`, the free `status`). Red-first is recorded. No out-of-scope edits in P2/P3.

*Same model family as some earlier reviews, but a different family from the executor (DeepSeek).*

*— claude-opus-5-5, 2026-11-14*

## Execution

### P4 — relay APNs (`apns.ts` + `apns-client.ts` + core limits + `push` handling) — DONE

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 (executor, P4), 2026-11-14*

**Load-bearing check, re-run first: PASS.** `.tentacle/tmp/mobile-push/p4-load-bearing.ts`
(scratch, in this worktree) answers the three questions this slice stands on,
before any edit:

```
Q1 push parses: true | push-result parses: true | RELAY_FEATURES: ["push"]
Q2 ready: {"t":"ready","v":1,"id":"9TZTY3XSDgiwBf8BTxauNJ","features":[]} | after a push frame: closed 1008 | log: ["ready 9TZTY3XS","control-unexpected s1 push"]
Q3 concurrent on one session: [200,200,200] sessions: 1
Q3 410: 410 | 403: 403
Q3 timeout: timeout
Q3 request on a GOAWAY'd session: threw: New streams cannot be created after receiving a GOAWAY
Q3 fresh session works: 200 | connects: 2
```

1. **P3 is really in the tree**: both frames parse, `RelayFeature` already
   includes `"push"`. So P4 needed no protocol change at all — and
   `packages/protocol/schema/protocol.json` is untouched (verified: `git diff`
   on it is empty), so no `schema:export` was needed.
2. **The capability is missing, as the plan says**: today's relay closes the
   control socket on a `push` (`control-unexpected … push`, 1008) and announces
   `features: []`. That close is this slice's red baseline: the new tests fail
   on the old code by never seeing a `push-result`.
3. **Bun's HTTP/2 client covers Design 4's needs**: concurrent streams on one
   session, real `GOAWAY` (after which `request()` throws, so recovery must be
   explicit), `410`/`403` bodies, and a working per-request deadline. This is
   what makes `apns-client.ts` testable against a local h2c fake, with no TLS
   and no secret.

**Files (P4's list, nothing else).** `apps/relay/src/apns.ts` (new, pure);
`apps/relay/src/apns-client.ts` (new, sockets); `apps/relay/src/relay-core.ts`
(push limits + the `push` decision + `features`); `apps/relay/src/server.ts`
(`apns` option, `features`, `push` handling, two limit flags);
`apps/relay/src/main.ts` (four `--apns-*` flags + env, `apnsSetupOf`);
`apps/relay/test/{apns,apns-client,server-push}.test.ts` (new, 63 tests);
`apps/relay/test/main.test.ts` (extended: the flags, `apnsSetupOf`, the help
text); `changelog.d/mobile-push-relay-apns.added.md` (new).

**As built, in Design 4's order.**
- `apns.ts` is pure and holds every decision: `APNS_APS_TEMPLATE` (the one
  banner), `apnsPayloadOf` (which re-parses through P2's STRIP payload schema, so
  a daemon's `aps` cannot reach a banner — belt *and* braces with the frame
  schema), `apnsRequestOf`, `createApnsJwtSource` (ES256 via WebCrypto, 40-minute
  cache, injected clock), `apnsOutcomeOf` (the whole status table),
  `readApnsKeySource` / `decodeApnsKeyPem` (all four `--apns-*` values or none).
- `apns-client.ts` is sockets only: one session per environment, lazily dialed,
  retired on `goaway`/`close`/`error`, a 10 s deadline per request, `ExpiredProviderToken`
  → invalidate + retry exactly once. `send` never throws.
- `relay-core.ts`: `pushesPerMinutePerId: 120` / `pushesPerMinutePerToken: 30`
  in `RELAY_LIMITS` (so a flag can override them), `push()` returning a
  `PushDecision`, `pushResult()` building the frame, and per-id windows dropped in
  `controlClosed`. A `push` from a socket with no `hello` is refused **and**
  closed.
- `server.ts`: the `apns` option is the *only* thing that puts `"push"` in
  `ready.features`; a `push` frame measures its body (`apnsPayloadBytesOf`)
  before the core's caps, delivers through the client, and answers on the socket
  that asked. Delivery is `void`-dispatched, so pushes are concurrent and can
  answer out of order.
- `main.ts`: the four flags/env values, `--max-pushes-per-minute` /
  `--max-pushes-per-token-per-minute`, and `apnsSetupOf`, which turns a key into
  a delivery path or logs one `push off: …` line and starts **without** push.

**Drift from the Implementation, and why.**
1. **A refusal is a `push-result`, not a close — except before `hello`.** The
   design says limits "refuse"; it does not say how. A cap refusal that closed
   the socket would cost the daemon its reachability (and every other push in
   flight) over one over-eager minute, so caps answer `throttled`, an
   unconfigured relay answers `rejected`/`no-push`, and only the
   pre-registration case closes (a socket that is not a daemon has no business
   on the route).
2. **`payloadBytes` is passed into the core.** The 4096-byte bound is the
   relay's own ceiling on what it hands Apple, and it cannot be checked by a strip
   schema (which bounds `c`'s length, not the assembled body). `server.ts`
   measures and the core refuses, so the bound is one pure decision rather than
   an `if` in the socket code.
3. **Two extra pure helpers beyond the plan's list**: `apnsPayloadBytesOf`
   (the measurement `server.ts` and the tests share) and `apnsSetupOf` in
   `main.ts` (the key → path decision, async because importing the key is, and
   injectable so "no key" and "unreadable key" are tests, not process spawns).
4. **`readApnsKeySource` requires a reader to be injected.** A source built with
   four values and no reader is an `error`, not a silent "pem with empty string":
   the process passes `readFileSync`, a test passes a function.
5. **`features` is an option on `RelayCore`, not a constant.** The relay build
   announces `"push"` *iff* `startRelay` was given an `apns` path; a test can
   build a core with `[]` to pin the "hand-written frame" refusal.

**Red before green.** The new behaviour's red baseline is the load-bearing
probe's Q2 (above): on the old code a `push` frame is closed 1008 and no
`push-result` ever exists. Test-file-level red is recorded honestly as what it
was: running the new `server-push.test.ts` against the old sources fails at the
module boundary (`Cannot find module '../src/apns-client.ts'`), which §9 says is
not a property-bearing red — so the property evidence is the mutation table
below, each mutation applied to `src`, run against the narrow files, and restored
from a scratch backup under `.tentacle/tmp/mobile-push/p4-mut-backup/` (**never**
git). The restore check is the script's last step: `diff` against the backup is
empty and the suite is green again.

| # | Mutation (one line) | Result |
|---|---|---|
| M1 | JWT cache never expires (`&& true`) | **RED** "reused at 39 minutes…" |
| M2 | JWT cache never reused (`if (false)`) | **RED** same |
| M3 | `APNS_JWT_REUSE_MS` 60 min instead of 40 | **RED** same |
| M4 | 410 → `rejected` instead of `gone` | **RED** "410 and a 400 BadDeviceToken… → gone" |
| M5 | `ExpiredProviderToken` no longer asks for a retry | **RED** 3 (table + both client retry tests) |
| M6 | the retry loops (a second request ignores `retry`) | **RED** "does not retry a third time" |
| M7 | `aps` taken from the daemon's payload (no template) | **RED** 4 (incl. the `rm -rf` body test) |
| M8 | topic hard-coded instead of from config | **RED** "the topic is the config's" |
| M9 | a `push` before `hello` is allowed | **RED** 2 (refusal + close) |
| M10 | per-token cap off by one | **RED** 2 |
| M11 | per-id cap off by one | **RED** 2 |
| M12 | the payload byte bound is not enforced | **RED** "the body's byte bound…" |
| M13 | `features` always announce `"push"` | **RED** 2 (bare relay's `ready`, `no-push`) |
| M14 | GOAWAY'd/closed/errored sessions are all reused **and** the state check is off (4 one-line edits together) | **RED** "GOAWAY → the next push dials a fresh session" |
| M15 | timeout ignores the injected `timeoutMs` | **RED** "a hung request times out" |
| M16 | the response body is read at header time | **RED** 4 (every reason-carrying outcome) |
| M17 | the log line carries the whole token | **RED** "no log line carries…" |
| M18 | the log line carries the sealed payload | **RED** same |
| M19 | an unregistered socket's push is refused but not closed | **RED** 2 |
| M20 | the push window is not dropped on unregister | **RED** "unregistering an id forgets its windows" |
| M21 | half-configured APNs keys are accepted | **RED** 2 (pure + `apnsSetupOf`) |
| M22 | an unreadable key file falls through | **RED** 2 |

**M14 is the one honest gap, and it is stated rather than hidden.** The
retirement is deliberately redundant (`goaway`, `close`, `error` handlers *and*
`sessionFor`'s `closed`/`destroyed` re-check), so no SINGLE layer's removal makes
the test red — I verified each in isolation (M14a: `goaway` handler off → 15/15
survive; M14b: the state check off → 15/15 survive). Removing all of them
together is RED. So the test pins "a GOAWAY'd client recovers", not "this
particular line does it", which is the property Design 4 asks for; a reviewer
wanting line-level pinning would have to accept a redundancy being tested by
behaviour instead.

**Failure modes covered by this slice.** F2/F3 (a hung or unreachable APNs →
`unavailable`, never a throw into the frame loop), F4/C1 (`features` empty
without a key, the frame refused), F5 (only the token prefix, Apple's own reason
word and the three sizes reach a log — M17/M18), F10 (per-id + per-token caps,
each with a status; a second id and a second token each have their own budget),
F11 (`gone` on 410 / `BadDeviceToken` / `DeviceTokenNotForTopic`), F15 (JWT
refreshed at 40 min and forced once on `ExpiredProviderToken`, never a storm),
F19 (out-of-order `push-result`s), F25's analogue (an unreadable key is a relay
that starts without push, not one that fails), a malformed frame or an
out-of-range ttl is a close (the schema), and a `push` on a `/v1/accept` leg is
still malformed there. F1/F8/F9's content boundary is pinned by M7: the banner
is a constant.

**Gate (this worktree, this branch).** `bunx tsc --noEmit` → clean, exit 0.
`bun run typecheck` (root + `apps/mobile` + `apps/relay`) → exit 0.
`bun run lint` → `Checked 1377 files in 393ms. No fixes applied.` (baseline:
clean, 0 errors / 0 warnings). `bun test` → **10000 pass, 4 skip, 0 fail**
(10004 tests / 720 files); the 4 skips are the documented opt-ins, and this slice
adds none. No wire change, so no `protocol.d/` note and no `PROTOCOL_VERSION`
move; `protocol.json` untouched.

**Not done, by instruction:** P5–P10 (`push-store.ts`, `push-rules.ts`,
`push-notifier.ts`, the `HostedSession` hook, `relayLink.push`, `serve`'s config,
the app, the Maestro flow and the runbook) are untouched. In particular the
daemon side that *sends* `push` frames, and the end-to-end test that proves a
sealed envelope reaches this fake APNs through the relay link, are P7/P8's.
`--apns-*` in `apps/relay/deploy/relay.service` is P10's (the deploy test that
pins ExecStart still passes, and correctly asserts no secret in argv).

**Unverified:** real APNs (D2a + D2, owner-approved) — nothing here has talked to
Apple. The transport facts it relies on are P0(b)'s sandbox probe and this
slice's h2c fake; the `.p8` → WebCrypto import is proved with a generated key
(`apnsSetupOf` test), not with an Apple-issued file.

## Review

### Review — P4 (fresh context, scope `git diff main...HEAD`)

**Verdict: REQUEST-CHANGES.**

1. **MEDIUM — the per-token cap is per (id, token) and resets on reconnect** (`apps/relay/src/relay-core.ts:514,521,720` scopes `tokenWindow` inside the id's `PushWindow`; `relay-core.ts:560` `this.pushes.delete(id)` on `controlClosed`). The design (Design 4, F10) and the code's own comment (`relay-core.ts:59`, "per DEVICE token — the one a third party could spray") mean a global per-token bound. Probe (`.tentacle/tmp/mobile-push/rev-p4-probe.ts`, `RelayCore` direct, same minute): 3 ids → **90** pushes accepted to one token (cap 30); the same id after close + re-`hello` → **30 more** in the same minute. F10's bound becomes `30 × ids` (with any secret being an id) and reconnecting launders both windows. Not recorded as drift. Fix: a relay-wide token map (bounded), keep per-id windows across a reconnect of the same id (or until the minute ends); add tests at N/N+1 across two ids and across a reconnect.
2. **MEDIUM — JWT minting is not single-flight** (`apps/relay/src/apns.ts:169` `createApnsJwtSource.jwt()`: check `cached`, then `await mint()`). Probe: 5 concurrent cold `jwt()` → **5 distinct tokens**. Same at every 40-min boundary, and on an `ExpiredProviderToken` burst each in-flight push calls `invalidate()` + mints (`apps/relay/src/apns-client.ts` `attempt`). Apple answers frequent token changes with 429 `TooManyProviderTokenUpdates` → `throttled` for real pushes. F15 says "never a storm"; this is a small one. Fix: memoise the in-flight mint promise; make `invalidate` a no-op for a token already replaced (compare the JWT that failed). Test: concurrent `jwt()` → one `sign` call.
3. **MEDIUM (plausible, not reproduced) — a timeout never retires the session** (`apps/relay/src/apns-client.ts:135`: `req.close()` only). A half-open connection (idle NAT drop, no GOAWAY/error) makes every push `unavailable/timeout` until the kernel gives up on the socket (minutes). Fix: retire the session on a timeout (or ping before reuse); test with an h2c fake that accepts streams and never answers, then answers on a fresh session.

**Gate (this worktree).** `bun test apps/relay` → 148 pass, 0 fail (7 files). `bun run lint` → clean, 1377 files. `bun run typecheck` → exit 0. Full `bun test` not re-run (scope: P4 files).

**Mutation (own).** `clipApnsReason` returns the raw reason → RED ("a reason is clipped to a header-safe, bounded word"); restored from a scratch copy, `git status` clean. Executor's M1–M22 table not re-run.

**Attacks tried.** (a) push before `hello` → closed 1008, holds. (b) daemon-supplied `aps` → stripped by `PushPayloadSchema` re-parse, template constant, holds. (c) topic from config only, holds. (d) cross-id / reconnect cap bypass → finding 1. (e) concurrent JWT mint → finding 2. (f) dead-but-open session → finding 3. (g) logs: token prefix + Apple's clipped reason only; key-file error message names the path, never key bytes — holds. (h) `void client.send(...)` keeps the peer unserialized; `send` never throws — holds.

**§7.** No protocol/persistence change; `protocol.json` untouched; "relay not trusted" boundary intact (content opaque, banner constant).

**Executor behaviour.** Thorough, honest about M14's redundancy gap and the module-level red; findings 1–2 are spec drift not flagged in Drift.

*— claude-opus-5-5, 2026-11-15* (different model family from the executor, DeepSeek)

## Execution

### Fix round 1

**Scope.** The three HIGH/MEDIUM findings of the P4 review (scope `git diff
main...HEAD`, slice P4). Nits were left alone; the review raised none that block.

**Reproduced first, before any edit** (`.tentacle/tmp/mobile-push/fix1-probe.ts`,
`RelayCore` direct + the real `createApnsJwtSource`, one injected clock):

```
F1a 3 ids -> 90 accepted to ONE token (cap 30)
F1b close + re-hello -> 60 accepted to ONE token (cap 30)
F2 4 concurrent cold jwt() -> 4 distinct token(s)
```

Finding 3 is not reproducible without a fake that can go half-open; it is pinned
by a test instead (below), since the review itself marked it "plausible, not
reproduced".

**1. MEDIUM — the per-token cap was per (id, token) and reset on reconnect. FIXED.**
`relay-core.ts`: the per-token window moved OUT of the id's bookkeeping into one
**relay-wide** map (`pushTokens`), so one device token has one budget whatever id
pushes to it. The per-id window is now keyed by the ID (not by the socket) and
**kept** across `controlClosed`, so reconnecting the same id resumes its minute
instead of laundering it. Both maps are bounded exactly as `ips` is — the oldest
entry is evicted at `maxTrackedPushTokens` / `maxTrackedPushIds` (a fairness
reset, not a bypass: the other bound still applies) — because "kept across
reconnects" must not become "one entry per id forever". Design 4 and F10's
wording now say "relay-wide", which is what they always meant (`relay-core.ts`'s
own comment: "per DEVICE token — the one a third party could spray").
Tests: `the per-TOKEN cap is relay-wide…` (core), `a second ID does NOT get its
own per-token budget` (end-to-end over real sockets), `a reconnect of the SAME id
does not launder its per-ID window`, and one bound test per map.

*A first attempt expired an idle id's window after 2 minutes instead of bounding
the map. The mutation run showed the difference is unobservable — a
fixed one-minute window resets itself first — i.e. the test would have been
vacuous, so it was replaced with the eviction the IP map already uses.*

**2. MEDIUM — JWT minting was not single-flight. FIXED.** `apns.ts`:
`createApnsJwtSource` memoises the **in-flight** mint promise, so N concurrent
callers on a cold cache (or at a 40-minute boundary) share ONE signature; the
promise is cleared in a `finally`, so a failed mint does not wedge the cache.
`invalidate(jwt?)` now takes the token that failed and is a **no-op when the
cache already holds a different one** — an `ExpiredProviderToken` burst reaches
every in-flight push with the same stale JWT, and each was wiping the fresh token
a sibling had just minted, minting once per push (`apns-client.ts` passes `jwt`).
Tests: `concurrent calls mint ONE token`, `invalidate(staleJwt) does not drop a
token a sibling already replaced`, `a mint that fails does not wedge the cache`,
and the client-side `an ExpiredProviderToken retry names the FAILED token`.

**3. MEDIUM — a timeout never retired the session. FIXED.** `apns-client.ts`: on
the deadline the client now closes the stream, **drops the session from the map
and destroys it**, so a half-open connection (an idle NAT drop sends no GOAWAY and
no error) costs exactly one push and the next one dials fresh. In-flight siblings
on that session settle on their own timers — they were dead anyway.
Test: `a timeout RETIRES the session, so a half-open connection costs one push`
(the fake makes the *existing* session deaf — it keeps accepting streams and
never answers — while a new session still answers, which is the property: the same
client recovers with no restart and no second timeout).

**Mutations.** `sh .tentacle/tmp/mobile-push/fix1-mut.sh` — one edit at a time,
each run against the three narrow test files, restored from a scratch backup under
`.tentacle/tmp/mobile-push/fix1-backup/` (**never** git); the script ends with a
`diff` against the backups (empty) and a green re-run. `R*` restore the ORIGINAL
bug (red-first evidence, §9); `M*` break a line of the fix.

| # | Mutation (one line) | Result |
|---|---|---|
| R1 | the per-token window scoped per id, again | **RED** 2 (core cross-id + the end-to-end cross-id test) |
| R2 | `controlClosed` drops the per-id window, again | **RED** "a reconnect of the SAME id…" |
| R3 | no single-flight mint | **RED** "concurrent calls mint ONE token" |
| R4 | `invalidate()` drops the cache unconditionally | **RED** "invalidate(staleJwt) does not drop…" |
| R5 | a timeout no longer retires the session | **RED** "a timeout RETIRES the session…" |
| M1 | the per-token window is never charged | **RED** 5 |
| M2 | the per-id map is unbounded | **RED** "the per-id push windows are bounded…" |
| M3 | the relay-wide token map is unbounded | **RED** "the relay-wide token windows are bounded too…" |
| M4 | `invalidate()` never drops anything | **RED** "invalidate(staleJwt)…" |
| M5 | the in-flight promise is never cleared | **RED** 4 (incl. "a mint that fails does not wedge…") |
| M6 | the timeout retires without settling the stream | survives — **stated, not hidden**: the property M6 would break (a timed-out stream that is never `close()`d) is subsumed by `session.destroy()`, which kills every stream on the session anyway; the explicit `req.close()` is defensive, so no single-line removal is observable |
| M1–M3 first run | (as found) | R2 and M2 **survived** the first draft — that is what moved the reconnect test to a per-ID-only limit and the expiry into a bounded map. Recorded rather than quietly fixed. |

**Drift from the Implementation.** One, deliberate: the review's "keep per-id
windows across a reconnect *or until the minute ends*" is implemented as
"keep them, bounded by `maxTrackedPushIds`" — an idle-expiry variant was tried
first and could not be kept honest (see finding 1's note).

**Gate (this worktree, this branch).** `bunx tsc --noEmit` → exit 0.
`bun run typecheck` (root + `apps/mobile` + `apps/relay`) → exit 0. `bun run lint`
→ `Checked 1377 files in 471ms. No fixes applied.` (baseline clean, 0/0).
`bun test` → **10009 pass, 4 skip, 0 fail** (10013 tests / 720 files; the 4
skips are the documented opt-ins and this round adds none). No wire change, so no
`protocol.d/` note and no `PROTOCOL_VERSION` move; `protocol.json` untouched.

*— claude-opus-5-5 (executor, fix round 1), 2026-11-16*

### Round 2 (scope `git diff HEAD~1`, commit `ecb2a50e`)

**Verdict: APPROVE.** All three findings fixed; each fix pinned by a test shown RED under mutation (applied to `src`, restored from a scratch copy, `git status` clean after each).

| Finding | Fix | Mutation → result |
|---|---|---|
| 1 per-token cap per id / reset on reconnect | relay-wide `pushTokens` (`relay-core.ts:522`, `tokenWindow`); `controlClosed` keeps windows (`relay-core.ts:573`) | key token window by `${id}:token` → **RED** 2 (core + server); re-add `pushes.delete` + `pushTokens.clear()` on close → **RED** 1 |
| 2 JWT not single-flight | `inFlight` promise (`apns.ts:181`); `invalidate(failedJwt)` compare (`apns.ts:206`) | drop `return await inFlight` → **RED** "concurrent calls mint ONE token"; make invalidate unconditional → **RED** "invalidate(staleJwt) does not drop…" |
| 3 timeout keeps a dead session | `retire` + `session.destroy()` on timeout (`apns-client.ts:141-143`) | both removed → **RED** "a timeout RETIRES the session" |

**Regression attacks (nothing at MEDIUM+).** Mint rejection clears `inFlight` in `finally` (no wedge); concurrent `invalidate(old)` after a sibling's mint is a no-op. A timeout now also errors sibling streams on that session → `unavailable/stream` (accepted: 10 s with no answer means the session is suspect). Nit: `tokenWindow`'s eviction is insertion-order, not "stalest" as its comment says; harmless (per-id cap bounds a flush). A relay-wide token cap lets a holder of the victim's token spend that device's budget — it already needs the token (F10), accepted.

**Gate.** `bun test apps/relay` → 157 pass, 0 fail. `bun run lint` → clean (1377 files). `bun run typecheck` → exit 0. Full `bun test` not re-run.

*— claude-opus-5-5, 2026-11-15* (different model family from the executor, DeepSeek)
