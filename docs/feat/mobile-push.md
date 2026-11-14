# feat/mobile-push — end-to-end encrypted push through the mobile relay (APNs) + the daemon's grace rule (mobile task 16)

> **Status:** implementation (plan written, **not approved**; see Owner questions)
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
  120 pushes/min, per token 30/min, payload ≤ 4096 bytes after templating. A
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
| F10 | **Third party abuses the relay to spam a token** | It needs a registered relay id (any secret will do) AND the device token. The token only travels phone → paired daemon (inside Noise) → relay. Bounded by per-token 30/min and per-id 120/min, and content is only placeholders. Accepted. |
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

## Execution

## Review
