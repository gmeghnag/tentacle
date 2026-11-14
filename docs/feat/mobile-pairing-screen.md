# feat/mobile-pairing-screen — pair a computer from the app, the Keychain computer store, the `/e2e` link (mobile task 11b)

> **Status:** implementation (plan written, **not approved** — see Owner questions)
> **Branch:** umbrella `feat/mobile-pairing-screen` (this doc). Split (Owner Q1): `feat/mobile-pairing-core` (**11b.1**) then `feat/mobile-pairing-camera` (**11b.2**), each carved from its section below (the `device-pairing` precedent).
> **Size:** L as a whole → split: 11b.1 **L** · 11b.2 **S** · **Blast:** 11b.1 **load-bearing** (it stores the phone's credential and replaces the transport every app screen dials through — the phone's half of "identity with the user" and "one session path") · 11b.2 contained · **Suited:** 11b.1 a strong executor (native toolchain + simulator judgment, as 11a) + mandatory fresh-context Opus Review that red-teams key storage, the `/e2e` dial and the harness; 11b.2 any capable executor + fresh-context Opus Review (its Maestro run is part of the gate, decision 20).
> **Changelog:** `changelog.d/mobile-pairing-screen.added.md` (11b.1, the first user-visible slice); `changelog.d/mobile-pairing-camera.added.md` (11b.2). Texts under *Changelog fragments*.

## Context

*— claude-opus-5-5, 2026-11-14*

Mobile task 11 (`docs/eval/mobile-app.md` decision 21, row 11) was split on
2026-11-13: **11a** (`docs/feat/mobile-app-shell.md`, merged) built the shell,
the session list and the `bun run e2e:mobile` harness, and left pairing
behind a seam; **11b (this task)** is the pairing flow, now unblocked because
task 9 (`docs/feat/device-pairing.md`, 9a–9d) is fully merged (`5f90188`):
device store, the `/e2e` route + revoke, the `device/pair` exchange with QR +
6-digit compare code, and `tentacle pair` / `devices` / `revoke` / `reset`.

Owner decisions it serves:

- **Decision 2:** the link addresses, never authorises; access is a per-device
  key; E2E on every path; the app keeps several addresses per computer and
  tries them in order.
- **Decision 3:** scan the QR (or paste the text, iPad / no camera); the app
  generates its own device key, **Keychain, this-device-only: no iCloud backup,
  no migration**, and sends it with a device name; the computer confirms; one
  app, many computers.
- **Decision 7:** pairing is per computer (one `pair` covers every `serve` of
  that computer).
- **Decision 10:** camera permission asked only when needed and explained.
- **Mockups (2026-11-01):** the pairing screen shows the QR flow **and the
  compare code** on both ends; native iOS look, inset grouped lists.
- **Decision 20:** `bun run e2e:mobile` mandatory before merging a mobile task.

Carry-overs addressed to 11b (verified in the source docs):

- 11a "Notes / debt" (`mobile-app-shell.md:376-382`): **delete the dev
  computer source and its build-time token**; the 401 cause split; Hermes
  throughput of the Noise channel (task 8 measured 1 MiB ≈ 0.8 s on the
  simulator, `TODO.md:1215`).
- 11a Owner Q4 (`mobile-app-shell.md:366-369`): the harness's strip-origin
  proxy is temporary — **switch to a direct dial** once task 9 lands.
- Task 9 F11 (`device-pairing.md:466`): after a `devices reset` the phone's
  pinned key is wrong → `closed` → `unreachable` (transient by task 8's
  design); the app must say "this computer may have been reset — pair again"
  after repeated failures.
- Task 9 F23 (`device-pairing.md:478`): an older daemon has no `/e2e` route →
  401 at the upgrade (1006 on iOS) → the app's wording must cover "update
  tentacle on this computer".
- Task 9 9c drift (`device-pairing.md` Execution 9c): `random` is REQUIRED on
  `PairDeviceOptions` (Hermes has no WebCrypto → `expo-crypto`); `onCompare`
  also receives `protocolVersion`; `device/pair` has no client deadline (the
  daemon's 5-min window is the bound) — the app must offer Cancel.
- 11a flows assert **by testID only** (RN new architecture exposes no text to
  XCUITest, `apps/mobile/e2e/flows/01-shell.yaml:4-6`), so every value a flow
  must check (the compare code, a refusal reason, a computer id) is encoded in
  a testID.
- iOS 18: the runtime cannot be downloaded with Xcode 27.1
  (`mobile-app-shell.md` Execution, "iOS 18 is NOT covered"); the Maestro leg
  stays iOS 26.5 here too.

**Repro (2026-11-14, this worktree at `5f90188`): the capability is missing.**

```
$ rg -c "pairDevice|secureChannelFactory|expo-secure-store|expo-camera" apps/mobile
(no matches)
$ rg -n "devComputerSource\(|startStripOriginProxy\(|EXPO_PUBLIC_TENTACLE_URL:" apps/mobile/App.tsx apps/mobile/e2e/run.ts
apps/mobile/e2e/run.ts:190:  const proxy = startStripOriginProxy({ upstream: { host: "127.0.0.1", port: daemonPort } });
apps/mobile/e2e/run.ts:334:    EXPO_PUBLIC_TENTACLE_URL: `ws://${proxyAddress}/`,
apps/mobile/App.tsx:32:const SOURCE = devComputerSource({
apps/mobile/App.tsx:33:  EXPO_PUBLIC_TENTACLE_URL: process.env.EXPO_PUBLIC_TENTACLE_URL,
```

The app never calls `pairDevice`, never dials `/e2e` through the Noise
initiator, stores nothing, and its only computer is the build-time `dev`
record dialled with a token through the Origin-stripping proxy. The
executor's first red test (11b.1 Tests, T-link) turns this into a failing
assertion: `openComputer` on a paired record, over a socket that sends an
iOS-style `Origin`, must list sessions — today it cannot even be called (no
key fields) and the plain route answers 401.

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

**The phone reaches a paired computer through the UNCHANGED `RemoteClient`
stack by giving it `secureChannelFactory(dial-to-/e2e, { staticKey: device
key, remoteStatic: pinned computer key, random: expo-crypto })` as its
`channelFactory` — so pairing adds only a transport decorator and a store,
never a second session path (AGENTS §7), and the device route's Origin
exemption makes the proxy unnecessary.**

Proven in Bun, unproven on Hermes:

- `secureChannelFactory` is a factory decorator: dial, then `noiseInitiator`;
  `RemoteClient` takes the result as `channelFactory` unchanged and every
  redial is a fresh handshake (`packages/client/src/secure-channel.ts:1-7,36-50`).
- The `/e2e` route admits a known key with an iOS-style `Origin` and builds an
  unchanged `Connection` on the resolved channel; the plain route still 401s
  (task 9 Repro, `device-pairing.md:54-76`; pinned by
  `daemon/test/ws-device-route.test.ts`, 9b).
- 11a's link already wraps exactly one factory with the foreground gate and
  hands it to `RemoteClient` (`apps/mobile/src/connection.ts:117-160`, gate at
  `:132`): replacing `webSocketChannelFactory(url, {token})` (`:124-128`) with
  the secure factory is the whole connection change.
- **Hermes:** task 8 ran the Noise channel on the simulator (1 MiB frame
  ≈ 0.8 s, `TODO.md:1215`), but never `pairDevice` / `@noble` SAS / a full
  `RemoteClient` over `/e2e` in a Release build. → **Step 0** (blocking).

### Preconditions

- **P1 — `pairDevice` is the app's whole exchange** (`packages/client/src/pairing.ts:127`):
  one dial per payload address in order, Noise initiator pinned to
  `payload.key`, `initialize` (30 s deadline), `onCompare(sas, {protocolVersion})`
  **awaited** before `device/pair` (`:77,196`), then `device/pair` with **no**
  client deadline, and `peer.close()` in `finally` (`:211`). A
  `PairingRefused` stops the address loop (`:132-140`); otherwise the last
  failure, or `ChannelError("unreachable")` when several failed. `random` is
  required (`:71`). Reasons have shipped copy, `PAIRING_REFUSED_MESSAGES`
  (`:98-106`). Subpath `@tentacle/client/pairing` (`packages/client/package.json`
  `exports`).
- **P2 — the payload codec** (`packages/protocol/src/pairing.ts`):
  `parsePairingPayload(text)` (`:198`) returns a result with a reason
  (strict on `v`/`k`/`c`/`a`/name, unknown params ignored); `PairingPayload`
  (`:138`); ≤ 8 addresses (`MAX_PAIRING_ADDRESSES`), each a `ws(s)` URL ending
  `/e2e`; `normalizePairingCode` for a typed code; `encodeBase64Url` /
  `decodeBase64Url` Hermes-safe (no `Buffer`/`btoa`).
- **P3 — the computer id is the pinned key's id.** The daemon answers
  `computer.id = deviceIdOf(identity.publicKey)` for the identity the
  connection was admitted against (`packages/daemon/src/pairing-handler.ts:192-203`);
  the channel was authenticated against `payload.key`, so `result.computer.id`
  names exactly the key the app pins. The record id is that value
  (`DEVICE_ID_RE`, `packages/protocol/src/device.ts`).
- **P4 — an EXPIRED or USED-UP window is a handshake deny, not a refusal.**
  The authority admits an unknown key as `pairing` only if a fresh read finds
  an unexpired window whose `pair` pid is alive; else it denies in message 2
  (`device-pairing.md:296-302`) → `ChannelError{kind:"unauthorized"}`
  (`secure-channel.ts` `KIND`: `denied → unauthorized`). So "QR expired /
  `pair` stopped" reaches the app as `unauthorized` from `pairDevice`, never as
  `PairingRefused{timeout}` (that one is a window that expired WHILE waiting
  for the human).
- **P5 — `unauthorized` is terminal and authenticated on `/e2e`.**
  `terminalReason` stops the link on `ChannelError{unauthorized}`
  (`packages/client/src/link-machine.ts` `terminalReason`) and reports
  `LinkStatus{state:"stopped", reason}` — a TEXT reason. Unlike 11a's 1006
  (which iOS gives for both a bad token and an Origin 401), a Noise `denied`
  needs the daemon's static key, so on `/e2e` it reliably means "this key is
  not registered": revoked (F7/F8) or reset. `closed` / `timeout` stay
  `unreachable` (an on-path party can forge them), so a computer reset is NOT
  distinguishable from an outage in one attempt (F11).
- **P6 — `pair` is drivable in-process** (`packages/cli/src/pair.ts:50-92`):
  `pairCommand({configDir, extraAddresses, interfaces, qr:false, out, err,
  ask, ttlMs})`; `out` receives the payload line (`:289`); `ask(prompt)` gets
  `Add '<name>'? It must show 123 456. [y/N]` (`:201-202`); **no `ask` ⇒ the
  claim is declined** (`:72`), so the harness cannot spawn the CLI on a pipe —
  it must call `pairCommand` with an injected `ask`. `revokeCommand(word,
  deps)` / `resetCommand` are exported from `packages/cli/src/devices-cmd.ts:167,203`.
- **P7 — `serve` mounts `/e2e` on every bind by default** (`devices` unless
  `options.devices === false`, `packages/cli/src/serve.ts:239-260`) and writes
  `<configDir>/daemons/<pid>.json`; a loopback bind contributes no address to
  the QR (`device-pairing.md:359-364`), so the harness passes
  `extraAddresses: ["ws://127.0.0.1:<port>/e2e"]` and `interfaces: []`.
- **P8 — the 11a seam** (`apps/mobile/src/computers.ts:11-20`):
  `ComputerRecord {id, name, url, token?}` + `ComputerSource.list()`;
  `App.tsx` reads it once into `RECORDS` (`:32-39,74-80`), the link registry
  dials by id (`:45-66`), `initialRoute([]) = "Pair"` (`routes.ts:36-38`).
- **P9 — single broker** stays as 12a built it: `createLinkBroker()`
  (`connection.ts` `createLinkBroker`), one per link; pairing opens no session
  and no broker (`pairDevice`'s peer answers any daemon request with
  `Unauthorized`).
- **P10 — the harness** (`apps/mobile/e2e/run.ts`): real `serve --port <p>
  --token e2e-token` on `runDir/config` (`:196-221`), the proxy (`:190`), the
  build env (`:331-336`), hooks over a localhost control port read by Maestro
  `runScript` + `http.get`, returning values through `output`
  (`flows/03-add-delta.js`); flows start with `launchApp: {clearState: true}`.

### Design

**Shape.** Everything stays in `apps/mobile/**` (+ `bun.lock`). No protocol,
daemon, client or CLI change: task 9 shipped every seam the app needs
(P1–P7). Logic in pure, React-free modules with `bun test`; screens render a
view-model and carry testIDs (AGENTS §7 "logic in pure modules").

**Step 0 (11b.1, blocking risk) — Hermes over `/e2e`.** Before product code,
a throwaway screen in a Release build on the iOS 26.5 simulator: generate a
key with `generateStaticKeypair(expoRandom)`, `pairDevice` against a real
`serve` with an in-process `pairCommand` answering `y` (the harness hook
below, hand-run), then `openComputer` over `/e2e` and `session/list` of a
200-entry seed. Paste: handshake ms, `pairDevice` ms, `session/list` ms, and
the SAS shown vs the one `pair` printed. A failure (an `@noble` / `BigInt` /
`TextEncoder` gap under Hermes) → STOP and report (two-strike rule). Not a
gate on numbers: they are recorded for the binary-frames debt
(`TODO.md:1215`).

**1. Computer store — `src/computer-store.ts` (pure, injected Keychain).**

```ts
interface SecureKV {                       // expo-secure-store, injected
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
interface PairedComputer {                 // replaces 11a's ComputerRecord
  readonly id: string;                     // result.computer.id (P3)
  readonly name: string;                   // result.computer.name
  readonly computerKey: string;            // b64url, the PINNED static key
  readonly addresses: readonly string[];   // payload order (decision 2)
  readonly deviceName: string;             // what the computer shows (for "revoke <name>")
  readonly pairedAt: number;
}
```

- **Two kinds of items** (SecureStore has no enumeration): an index
  `tentacle.computers` = `{ v: 1, ids: string[] }` and one item per computer
  `tentacle.computer.<id>` = `{ v: 1, ...PairedComputer, deviceKey: b64url
  private key }`. The private key lives only in its computer's item, never
  in the index; it is read only by `openComputer`.
- **Accessibility:** every `set` passes ONE constant,
  `keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (Owner Q3) — no
  iCloud Keychain, no backup migration (decision 3). No
  `requireAuthentication` (the Face ID lock is task 14).
- **Order of writes (crash-safe without a transaction):** add/replace = item
  first, index second (a crash between leaves an unlisted orphan item, never a
  listed computer without a key); remove = index first, item second (a crash
  between leaves an orphan, never a listed computer whose key is gone). An
  orphan is harmless and overwritten by a later pairing of the same id.
- **Versioned like every on-disk record (§7):** an unknown `v`, or JSON that
  does not parse, in the index → `list()` rejects with a typed
  `StoreUnreadable` and **nothing is ever written** while it stands (a
  downgraded app must not erase a newer app's computers). An unreadable
  per-computer item → that computer is listed as `broken` (Remove / Pair
  again), the rest load.
- **A failed READ is never "empty"** (e.g. the Keychain before first unlock
  with a stricter class, a SecureStore error): `list()` rejects; the app
  shows "Can't read your paired computers — try again" and does not route to
  `Pair` as if nothing were paired. (A missing index = genuinely empty.)
- **Writes serialised** by an in-module promise chain (the JS thread is
  single, but each SecureStore call yields).
- `ComputerSource` becomes `{ list(); add(computer, deviceKey); remove(id) }`
  over this store; `devComputerSource`, its env names and
  `ComputerConfigError` are **deleted** with `apps/mobile/src/computers.ts`'s
  dev half.

**2. Pairing flow — `src/pairing-flow.ts` (pure reducer + one runner).**

States: `intake` → `review{payload, existing?}` → `connecting` →
`compare{sas}` → `done{computerId}` | `failed{reason, message, retry}`;
`cancel` from `review`/`connecting`/`compare`.

- **Intake (11b.1: paste; 11b.2 adds scan and the deep link):** the text goes
  through `parsePairingPayload` (trimmed). A parse failure → `failed{reason:
  "invalid-payload" | "payload-version"}`, **nothing is dialled**.
- **Review** (the confirm the deep link also needs, Owner Q6): "Pair with
  'MacBook'?", the addresses count, an editable **device name** prefilled
  `iPhone` / `iPad` (iOS 16+ hides the user-assigned name without an Apple
  entitlement; no `expo-device`), validated by the protocol's own
  `DevicePairParamsSchema.shape.name` (1–64, no control characters). If a
  stored computer has the same `computerKey`, `review.existing` is set: "Already
  paired — pair again?" (Owner Q7).
- **Run:** `runPairing({payload, name, store, dialOne, random, signal})`
  generates a **fresh device key per pairing** (Owner Q2:
  `generateStaticKeypair(random)`), calls `pairDevice` with `dial =
  (address) => dialOne(address)`, and an `onCompare` that dispatches
  `compare{sas}` and returns at once (it does not wait for a tap: the human's
  decision is the computer's `[y/N]`; the phone's job is to show the code).
  On success it writes the record (`store.add`: replace keeps the id) and only
  then dispatches `done`.
- **Cancel** (no client change): `dialOne` is wrapped so the runner holds the
  raw channel of the attempt in flight; Cancel closes it, `RpcPeer` rejects
  the pending `device/pair` and `pairDevice` closes its peer (P1). The key is
  discarded. If the computer already shows its prompt, the phone says "If the
  computer asks, answer N" (F-P9).
- **Error map** (`describePairingError`, exhaustive, never text-matched):

  | Input | `reason` (→ testID `pair-error-<reason>`) | Copy (gist) | Retry |
  |---|---|---|---|
  | parse failure | `invalid-payload` | "Not a tentacle pairing code" | edit |
  | unknown `v` | `payload-version` | "This code is from a different tentacle version — update the app or tentacle" | no |
  | `ChannelError{unauthorized}` | `expired` | "This code expired or `tentacle pair` stopped — run it again" (P4) | new code |
  | `PairingRefused{r}` | `r` (`invalid_code`, `used`, `declined`, `timeout`, `too_many_attempts`, `already_paired`, `unknown`) | `PAIRING_REFUSED_MESSAGES[r]` (P1) | per reason |
  | `RpcError{VersionMismatch}` | `version` | "Update tentacle on this computer or the app" | no |
  | other `ChannelError` / dial error | `unreachable` | "Can't reach '<name>' at its N addresses — same network or Tailscale? `tentacle serve --host 0.0.0.0` running and up to date?" (covers F23) | yes |
  | store write failed after success | `store` | "Paired, but this phone could not save it — pair again; then remove the stale entry with `tentacle devices revoke <name>`" | yes |

**3. The link over `/e2e` — `src/connection.ts` + `src/address-dial.ts` + `src/link-diagnosis.ts`.**

- `openComputer(computer, deviceKey, deps)` builds, per address,
  `secureChannelFactory(rawDial(address), { staticKey, remoteStatic:
  decode(computerKey), random })`, where `rawDial` is the client's
  `webSocketChannelFactory(address, {}, {WebSocket: rnWebSocketCtor(RN)})`
  (**no token**; iOS's `Origin` is accepted on `/e2e`). The foreground gate,
  the broker, `initialize`, `leaveComputer` and the returned `ComputerLink`
  are unchanged (P8/P9). `withDiagnostics` stays.
- `address-dial.ts` (pure): `firstAnswering(addresses, attempt, memory)` tries
  addresses in order starting at the last one that answered (memory is
  in-process only; task 10's announcement will update the list); a
  `ChannelError{unauthorized}` **stops** the loop and is rethrown (authenticated
  — a second address cannot change the verdict); any other failure tries the
  next; all failed → the last error. Same rule as `pairDevice` (P1).
- `link-diagnosis.ts` (pure): fed by the dial wrapper (which sees the error
  OBJECT and whether the raw socket opened — never the `stopped.reason`
  text), it yields `ok | unreachable | revoked | maybe-reset`:
  `unauthorized` → `revoked` ("This phone was removed from '<name>' — pair
  again or remove it"); **3 consecutive** attempts whose socket OPENED but
  whose handshake failed `closed`/`timeout` → `maybe-reset` ("'<name>' may
  have been reset (`tentacle devices reset`) — pair again", shown beside
  Retry, never instead of it, F11); a dial that never opened → `unreachable`;
  any success resets the count.
- `session-list.ts`'s `describeError` / `computer-rows.ts` take the diagnosis
  for a `ChannelError` instead of 11a's one-size "Can't connect" (the 1006
  ambiguity is gone on `/e2e`, P5). `MethodNotFound` stays "too old".

**4. Screens and routes.**

- `PairScreen.tsx` (rewritten, renders `pairing-flow`'s view-model): intake
  card with a multiline paste field (`pair-paste-input`, `pair-paste-submit`),
  the review card (`pair-review`, `pair-device-name`, `pair-confirm`), the
  connecting state (`pair-connecting`, Cancel `pair-cancel`), the compare card
  — the 6 digits large, grouped `123 456`, "Check that your computer shows the
  same code, then answer y there" — testID `pair-sas-<digits>`; the error card
  `pair-error-<reason>` with its action. 11b.2 adds the scan button above the
  paste card.
- `ComputersScreen.tsx`: a header "+" (`computers-add`) → `Pair`; each row's
  context menu / swipe "Remove" (`computer-remove-<id>`) → a native
  confirmation naming what it does: "Remove 'MacBook' from this iPhone. To
  also revoke it on the computer, run `tentacle devices revoke <deviceName>`"
  (Owner Q5) → `LINKS` closes that link (detach, never close), `store.remove`;
  the last removal resets the stack to `Pair`. Row states: `revoked` /
  `maybe-reset` / `broken` show their copy and a "Pair again" action
  (`computer-state-<id>-<state>`).
- `routes.ts`: `Pair` gains an optional `{ replace?: string }` param (pair
  again for an existing id); `initialRoute` unchanged; a store read failure
  routes to a `StoreError` view on `Computers`, not `Pair`.
- `App.tsx`: `SOURCE` = the Keychain store (`expo-secure-store` adapter in a
  5-line `src/secure-kv.ts` wiring file, the only native import), `RECORDS`
  filled from `list()`; after `done` → `navigation.reset` to `Computers`.
- `package.json`: `expo-secure-store` (11b.1) and `expo-camera` (11b.2),
  pinned exactly via `npx expo install` (Expo 58's matching versions; the
  executor records them) — `bun.lock` changes inside the `apps/mobile`
  entries (accepted precedent: 11a Owner Q1).

**5. The harness without the proxy (11b.1).**

- `run.ts`: no proxy, no `EXPO_PUBLIC_TENTACLE_*` in the build env (the build
  is the shippable one). `serve` keeps `--token e2e-token` for the harness's
  OWN laptop-side clients (`seed.ts`, hooks — plain route, Bun WebSocket, no
  Origin); the app reaches `serve` only through `/e2e`.
- `hooks.ts` new actions (in-process, P6/P7), one pairing at a time:
  - `/pair/start?ttlMs=&answer=y|n` → `pairCommand({configDir:
    runDir/config, extraAddresses: [ws://127.0.0.1:<port>/e2e], interfaces:
    [], qr: false, ask})`; responds `{payload, computerId}` as soon as `out`
    printed the line (`computerId` read from `readIdentity(configDir)`).
  - `/pair/confirm` → waits until `ask(prompt)` is called (the claim), answers
    per `answer`, responds `{sas}` parsed from the prompt — the flow then
    asserts `pair-sas-${output.sas}`: **both ends show the same code**.
  - `/revoke?name=` → `revokeCommand`; `/reset` → `resetCommand` answering
    `y`.
- Flows: each starts `launchApp {clearState: true}` + `clearKeychain` (iOS
  `clearState` does not wipe the Keychain), then a shared subflow
  `_pair.yaml` (start → paste `${output.payload}` → confirm → assert SAS →
  `computer-${output.computerId}`). Existing 01–05 switch from
  `computer-dev` to `computer-${output.computerId}` and run after `_pair`;
  flow 05's restart keeps `runDir/config`, so identity and registry survive
  and the phone re-dials as itself.
- Deleted: `e2e/proxy.ts`, `e2e/strip-origin.ts`,
  `test/e2e-strip-origin.test.ts`; `e2e/README.md` updated.

**6. 11b.2 — the camera and the deep link (S · contained).**

- `expo-camera` `CameraView` with `barcodeScannerSettings: {barcodeTypes:
  ["qr"]}`, opened only from a "Scan QR code" tap (decision 10:
  `NSCameraUsageDescription` = "tentacle scans the pairing code shown by
  `tentacle pair`"). The first decoded string goes into the SAME
  `pairing-flow` intake as a paste (one path); scanning stops on the first
  hit.
- Permission states as a pure `camera-access.ts` view-model:
  `undetermined → ask on tap`, `denied` → "Camera access is off — enable it
  in Settings, or paste the code" with `Linking.openSettings()` and the paste
  card still there; `unavailable` (simulator, iPad without camera, restricted)
  → paste only.
- Deep link (Owner Q6): register the `tentacle` scheme (`app.json`
  `scheme`); `Linking` URLs starting `tentacle://pair?` enter the same intake
  and **always stop at `review`** — a link opened by a web page or another app
  never dials by itself. Scanning with the iOS Camera app then opens the app
  on the review card.
- Flows: `12-camera-denied.yaml` (`launchApp: permissions: {camera: deny}` →
  tap scan → `pair-camera-denied` + paste still works), `13-deep-link.yaml`
  (`openLink: ${output.payload}` → `pair-review`, nothing dialled until
  confirm — the hook's `/pair/confirm` must not see a claim before the tap).
  The live camera decode is on the real-iPhone checklist (the simulator has
  no camera).

### Files

**11b.1 `mobile-pairing-core`** (dependency order):

1. `apps/mobile/package.json` + `bun.lock` — `expo-secure-store` pinned.
2. `apps/mobile/src/computer-store.ts` (new) — store, versions, write order.
3. `apps/mobile/src/computers.ts` — `PairedComputer`, `ComputerSource` over the
   store; dev source + `ComputerConfigError` deleted.
4. `apps/mobile/src/address-dial.ts` (new), `apps/mobile/src/link-diagnosis.ts` (new).
5. `apps/mobile/src/connection.ts` — `openComputer` over `/e2e` (secure factory, no token).
6. `apps/mobile/src/pairing-flow.ts` (new) — reducer, `runPairing`, `describePairingError`.
7. `apps/mobile/src/session-list.ts`, `apps/mobile/src/computer-rows.ts` — diagnosis-aware wording.
8. `apps/mobile/src/routes.ts` — `Pair` params.
9. `apps/mobile/src/secure-kv.ts` (new, wiring only), `apps/mobile/src/screens/PairScreen.tsx`, `ComputersScreen.tsx`, `apps/mobile/App.tsx`.
10. Tests: `apps/mobile/test/{computer-store,address-dial,link-diagnosis,pairing-flow,pairing-e2e}.test.ts` (new); `computers.test.ts`, `connection.test.ts`, `session-list.test.ts`, `computer-rows.test.ts`, `routes.test.ts` updated; `e2e-strip-origin.test.ts` deleted.
11. Harness: `apps/mobile/e2e/run.ts`, `hooks.ts`, `e2e/flows/_pair.yaml` + `pair-*.js` scripts, flows 01–05 updated, flows 06–11 new; `e2e/proxy.ts`, `e2e/strip-origin.ts` deleted; `e2e/README.md`.
12. `changelog.d/mobile-pairing-screen.added.md`; this doc (Execution).

**11b.2 `mobile-pairing-camera`:** `package.json` + `bun.lock`
(`expo-camera`), `app.json` (`scheme`, `NSCameraUsageDescription` via the
camera plugin), `src/camera-access.ts` (new), `src/deep-link.ts` (new, pure:
URL → intake text or nothing), `PairScreen.tsx`, `App.tsx` (`Linking`
listener), tests `camera-access.test.ts`, `deep-link.test.ts`, flows 12–13,
`changelog.d/mobile-pairing-camera.added.md`.

Not touched: `packages/**` (no protocol/daemon/client/CLI change), the
`tsconfig` `types: ["bun"]` stopgap (11a debt).

### Failure modes

| # | Case | Behaviour | Convergence |
|---|---|---|---|
| F-P1 | **Wrong / garbled pasted text** | `parsePairingPayload` fails → `invalid-payload`; nothing dialled | user re-pastes or rescans |
| F-P2 | Payload from another payload version | `payload-version`, no dial | update app / tentacle |
| F-P3 | **Wrong code** (well-formed, not this window's) | daemon `PairingRefused{invalid_code}` — only reachable if a window is open (else F-P4) | new QR |
| F-P4 | **Expired QR** / `pair` stopped / window gone | handshake **denied** → `unauthorized` → `expired` (P4) — never shown as "removed" | run `tentacle pair` again |
| F-P5 | Window expires while waiting for `y` | `PairingRefused{timeout}` | new QR |
| F-P6 | Code already used (another phone, a photographed QR) | `used`; the other device's SAS differs, so the human answers N there | new QR |
| F-P7 | **Human answers N** | `declined`; the generated key is discarded; nothing stored | — |
| F-P8 | Compare code differs between screens | the human answers N (the SAS is the check); the app shows the code it computed from the pinned key and ITS key — it cannot itself know a mismatch | F-P7 |
| F-P9 | User cancels on the phone | raw channel closed → `pairDevice` rejects, key discarded; a claim already made leaves the computer's prompt up → copy "if the computer asks, answer N"; a `y` anyway adds a stale entry visible in `tentacle devices` | `devices revoke` |
| F-P10 | All addresses unreachable (wrong network, loopback-only `serve`, old tentacle without `/e2e` = 401 at upgrade) | `unreachable` with the network / `--host 0.0.0.0` / update hint | Retry |
| F-P11 | `VersionMismatch` at `initialize` | `version`, no retry loop | update one side |
| F-P12 | Paired, but the Keychain write fails | `store` error naming the stale entry; record not listed | pair again + revoke stale |
| F-P13 | Crash between item and index write (add) | orphan item, computer not listed | the user pairs again; same id overwrites the orphan |
| F-P14 | Crash between index and item delete (remove) | computer unlisted, orphan item | overwritten on a later pairing of that id |
| F-P15 | **Camera denied** (11b.2) | denied card + Settings link + paste | — |
| F-P16 | Camera unavailable (simulator, restricted) (11b.2) | paste only | — |
| F-P17 | Hostile deep link (11b.2) | stops at review: the computer's name, its address count, and a dial only on tap; a hostile computer can at most pair the phone to ITSELF, which the user sees by name and must confirm on that computer | — |
| F-L1 | **Device revoked while connected** | daemon closes the socket; redial denied → `unauthorized` → link `stopped`; diagnosis `revoked`, row "removed from '<name>'", Pair again / Remove; sessions on the computer are detached, not ended (task 9 F7) | user's choice |
| F-L2 | Revoked while the app was closed | first dial denied → same as F-L1 | — |
| F-L3 | **Computer reset** (`devices reset`) | pinned key wrong → handshake `closed` → `unreachable`; after 3 opened-but-failed attempts the row adds "may have been reset — pair again" (F11) | pair again (replaces the record, same flow) |
| F-L4 | One address dead, another alive | `firstAnswering` falls through, remembers the good one | — |
| F-L5 | Daemon down / restarted (flow 05) | 11a behaviour: stale list, redial with backoff, refresh on `up` | — |
| F-K1 | **Reinstall** (Keychain items may survive app deletion on iOS — Apple behaviour, not a contract) | per Owner Q4: kept → the computers reappear and still work; gone → `Pair`, the old entries stay on the computers with an old "last seen" (task 9 F10) | revoke stale |
| F-K2 | **Key loss** (index present, one item missing / unreadable) | computer listed as `broken`: Pair again / Remove; the rest work | — |
| F-K3 | Index unreadable or unknown `v` (downgrade) | `StoreUnreadable` shown, **never overwritten**, no route to `Pair` | update the app |
| F-K4 | Keychain read error (before first unlock, OS error) | `list()` rejects → "Can't read your paired computers — try again"; nothing written | retry on foreground |
| F-K5 | Device restored from a backup / new phone | `THIS_DEVICE_ONLY` items do not migrate → `Pair` (decision 3) | pair the new phone, revoke the old |
| F-K6 | Same computer paired twice (re-pair after revoke/reset) | review warns; on success the record for that id is replaced (new key); the previous entry stays on the computer (it cannot be revoked from the phone, Owner Q5) — copy names it | `devices revoke` |
| F-K7 | Two writes racing (remove during a pairing) | store serialises writes; the UI disables Remove for the id being paired | — |
| F-H1 | Harness: `pair` without a TTY declines | the harness calls `pairCommand` in-process with `ask` (P6) | — |
| F-H2 | Harness: Keychain survives `clearState` | every flow runs `clearKeychain` | — |
| F-H3 | Harness: a flow leaves a pairing window open | `/pair/start` refuses while one runs; teardown resolves `ask` with `n` | — |
| F-H4 | Harness: a build accidentally carrying a computer/token | no `EXPO_PUBLIC_TENTACLE_*` exists anymore; a test pins that the app sources never read it | — |

### Tests

Red first (§9); each names the property and its mutation.

**11b.1, in the gate (`bun run check`, no simulator):**

- `computer-store.test.ts` (fake `SecureKV` recording calls + options, able to
  throw on the Nth call): round trip of two computers; the private key appears
  ONLY in its computer's item (*mutation:* put it in the index → red); every
  `set` carries `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (*mutation:* drop the
  option); add writes item before index — throw on the index write → `list()`
  does not show it (*mutation:* swap the order); remove deletes index entry
  before item — throw on the item delete → not listed; unknown `v` / garbage
  index → `StoreUnreadable` and **zero** writes afterwards, even on `add`
  (*mutation:* reset to empty); a read error rejects, never `[]`
  (*mutation:* `catch → []`); missing item → `broken`; concurrent add +
  remove are serialised.
- `address-dial.test.ts`: order; falls through on `unreachable`/`rejected`;
  **stops** on `unauthorized` without dialling the next (*mutation:* continue →
  second dial observed); starts at the remembered good address.
- `link-diagnosis.test.ts`: `unauthorized` → `revoked`; 3 opened-but-closed →
  `maybe-reset`, 2 → still `unreachable`; a never-opened dial does not count
  (*mutation:* count every failure); success resets.
- `pairing-flow.test.ts` (reducer + `describePairingError`): parse failure
  never calls the runner (*mutation:* dial anyway); every `PairingRefused`
  reason + `unknown` maps to a distinct testID slug (exhaustive `Record`);
  `ChannelError{unauthorized}` → `expired`, NOT `revoked` (*mutation:* reuse
  the link mapping); `VersionMismatch` → `version`; device-name validation
  uses the protocol schema (control char refused); `review.existing` set for a
  known `computerKey`; the store is written BEFORE `done` (*mutation:*
  dispatch first).
- `pairing-e2e.test.ts` — **the load-bearing test**, real I/O on loopback
  (the 9d `pair-e2e` pattern): `startWsServer` with a `DeviceAuthority` on a
  temp `configDir`, in-process `pairCommand` with an injected `ask`, the app's
  `runPairing` + `openComputer` dialling through `rnWebSocketCtor` around a
  Bun `WebSocket` that **sends `Origin: http://192.168.1.8:4001`**:
  - happy path: `onCompare`'s SAS equals the one in `ask`'s prompt; the store
    holds the record with `id = deviceIdOf(identity)`; then `openComputer` →
    `sessionList` returns a session created by a token client (**red today**:
    no keyed record, plain route 401);
  - `n` → `declined`, store empty; `ttlMs` elapsed before the dial →
    `expired`; Cancel during `compare` → `pairDevice` rejects and the server
    sees the pairing socket closed (*mutation:* Cancel only flips UI state →
    socket stays open, red);
  - revoke via `revokeCommand` while linked → the link reaches `stopped` and
    the diagnosis is `revoked` (*mutation:* diagnose from `stopped.reason`
    text with a changed message → red);
  - `resetCommand` → three redials → `maybe-reset`.
- `connection.test.ts` updated: the broker is still `createLinkBroker`'s
  (the 12a mutation still red); `close()` still detaches (no `session/close`).
- Guard: a test reads `App.tsx` + `src/**` and asserts no
  `EXPO_PUBLIC_TENTACLE` and no `token` in `PairedComputer` (F-H4).
- Typecheck covers the screens.

**11b.1, Maestro (`bun run e2e:mobile --ios 26`, decision 20):** flows 01–05
(through `_pair`), plus `06-pair-declined` (`pair-error-declined`),
`07-pair-expired` (`ttlMs=1500`, wait → `pair-error-expired`),
`08-pair-bad-text` (garbage → `pair-error-invalid-payload`, and `/pair/confirm`
reports no claim), `09-revoked` (pair → list → `/revoke` →
`computer-state-<id>-revoked`), `10-remove-computer` (remove → `Pair`;
relaunch WITHOUT `clearState` → still `Pair`: the removal persisted),
`11-persisted` (pair → relaunch without `clearState` → `computer-<id>`, list
loads: the Keychain record and key survive a relaunch). Red-before-green: `_pair`
against today's build (no paste field) fails. The green summary is pasted in
Execution; Review re-runs it. `maybe-reset` is covered by `pairing-e2e` only
(backoff timing makes a flow slow and flaky — debt).

**11b.2:** `camera-access.test.ts` (each permission state → its view-model;
`denied` keeps paste), `deep-link.test.ts` (only `tentacle://pair?` accepted;
other schemes/hosts ignored; the result enters `intake`, never `connecting` —
*mutation:* auto-confirm → red); flows 12–13 above.

### Changelog fragments

- `mobile-pairing-screen.added.md` — `- **Pair the app with a computer.** Paste the code from \`tentacle pair\`, compare the 6-digit code on both screens and confirm on the computer; paired computers (several) are kept in this iPhone's Keychain only, can be removed, and a revoked or reset computer says so. The app now connects only over the end-to-end encrypted \`/e2e\` route. Design: \`docs/feat/mobile-pairing-screen.md\`.`
- `mobile-pairing-camera.added.md` — `- **Scan the pairing QR.** The app scans \`tentacle pair\`'s QR with the camera (asked only when you tap Scan; paste still works when it is off), and a \`tentacle://pair\` link opens the app on a confirmation, never pairing by itself.`

### Owner questions

1. **Split** into 11b.1 `mobile-pairing-core` (L · load-bearing: store, paste
   + compare, `/e2e` link, remove, harness without proxy, `expo-secure-store`)
   and 11b.2 `mobile-pairing-camera` (S · contained: camera, deep link,
   `expo-camera`), each accepting its `bun.lock` diff? **Rec: yes** — the
   camera cannot be exercised on the simulator and carries its own native
   dependency; paste alone is a complete, Maestro-testable pairing path.
2. **Device key per computer or one per phone?** **Rec: per computer**
   (generated at each pairing) — removing a computer destroys exactly its key,
   two computers cannot correlate the phone by key, a revoke/reset re-pair
   needs a new key anyway, and `pairDevice` already takes one key per call.
3. **Keychain class:** `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` or
   `WHEN_UNLOCKED_THIS_DEVICE_ONLY`? **Rec: AFTER_FIRST_UNLOCK** — both are
   this-device-only (no iCloud, no backup migration, decision 3); the stricter
   class would block the background reconnects of tasks 16–18 (notification
   Approve, Live Activity) while the phone is locked, forcing a Keychain
   migration then.
4. **Reinstall:** keep whatever the Keychain still holds after the app is
   deleted (iOS usually keeps it) or wipe on the first launch of a fresh
   install? **Rec: keep, no wipe** — the computers still authorise that key
   (wiping only leaves stale entries to revoke), and "Remove" is the explicit
   forget; F-K1 handles both outcomes.
5. **Remove a computer = local only** (key deleted on the phone, the dialog
   names the `tentacle devices revoke <name>` to run), no self-revoke RPC?
   **Rec: yes** — a `device/forget` method would make the daemon a registry
   writer, breaking task 9's "only the CLI writes the registry" rule; revisit
   with the relay (task 15) if users ask.
6. **`tentacle://` deep link** (11b.2), always stopping on an in-app review
   before any dial? **Rec: yes** — the iOS Camera app's QR scan then opens the
   app directly, Maestro can drive it with `openLink`, and the review step
   keeps a hostile link from dialling.
7. **Re-pairing an already paired computer** replaces this phone's record and
   key for it after a confirmation (the old entry stays on the computer, named
   for revoke) rather than refusing? **Rec: replace** — it is the recovery path
   for revoked (F-L1) and reset (F-L3) computers.

### Notes / debt

- iOS 18 Maestro leg stays unverified (Xcode 27.1 cannot download the
  runtime, as in 11a); the real-iPhone checklist (iOS 18.3.1) covers it,
  including the live camera decode and the local-network prompt.
- `maybe-reset` has no Maestro flow (backoff timing); `pairing-e2e` pins it.
- Addresses are the pairing-time list until task 10's announcement updates
  them; the remembered good address is in-memory only.
- Binary WebSocket frames for the Noise channel (`TODO.md:1215`) stay wanted
  debt; Step 0's numbers inform it.
- The Face ID app lock (task 14) does not gate the Keychain items in 11b.

## Execution

*— claude-sonnet-4-5, 2026-11-14 — slice 11b.1 only (`feat/mobile-pairing-core`)*

**Scope.** 11b.1 only: the Keychain store, the paste+compare pairing flow, the
`/e2e` link, Remove/Pair-again, and the harness without the proxy. 11b.2 (camera,
deep link, `expo-camera`) is untouched.

### Step 0 — Hermes over `/e2e` (BLOCKING): PASSED

A throwaway probe (`.tentacle/tmp/mobile-pairing-core/step0/`, `apps/mobile/
step0-probe.tsx` + a temporary `index.step0.ts`, both reverted) replaced `App`
for one Release build on the iOS 26.5 simulator, against a real `serve` with 200
seeded sessions and an in-process `pairCommand` answering `y`:

```
{"parseMs":20,"keypairMs":86,"compareAtMs":59,"pairDeviceMs":371,
 "sas":"907869","deviceId":"34953038a1071263",
 "computerId":"27ed48215d916376","computerName":"gmeghnag-mac",
 "handshakeMs":99,"protocolVersion":24,"sessionListMs":111,"sessions":50}
```

- `generateStaticKeypair(expoRandom)`, `pairDevice`'s Noise initiator, the SAS
  (`@noble`) and `secureChannelFactory` over `/e2e` all run under **Hermes** in a
  Release build: no `BigInt`/`TextEncoder`/`@noble` gap.
- The phone's SAS `907869` equals the terminal's `must show 907 869` — the
  two-screens property holds on the real platform, not only in Bun.
- `pairDevice` 371 ms, `/e2e` handshake 99 ms, `session/list` (50 of 200) 111 ms.
  Recorded for the binary-frames debt (`TODO.md:1215`): the phone's whole path is
  far from the 1 MiB ≈ 0.8 s measurement that motivated it.
- Harness detail (not a product finding): `/confirm` cannot wait for `pair`'s
  prompt — `pair` prints the compare code only AFTER the claim, and the claim is
  the phone's next request. The probe's first two attempts deadlocked on exactly
  that; recorded so the harness's `pairing.ts` orders `confirm` → `answer`.

### As built, in dependency order

1. **`apps/mobile/package.json` + `bun.lock` + `app.json`** — `expo-secure-store`
   `58.0.3` (pinned exactly; `npx expo install` chose `~58.0.3`, which Expo 58
   matches), and its config plugin registered by the installer.
2. **`src/computer-store.ts`** (new) — the index + one item per computer, the
   injected `SecureKV`/accessibility class, add/replace/remove ordering, and
   `StoreUnreadable` for an unknown `v` or unparseable bytes (never overwritten).
3. **`src/computers.ts`** — `PairedComputer`/`ComputerSource` over the store; the
   dev source, its env names and `ComputerConfigError` deleted.
4. **`src/address-dial.ts`**, **`src/link-diagnosis.ts`** (new) — the address
   order/memory (`unauthorized` stops the loop) and the `ok|unreachable|revoked|
   maybe-reset` diagnosis fed by error OBJECTS.
5. **`src/connection.ts`** — `openComputer(StoredComputer, {WebSocket, random,
   diagnosis?})` dials `/e2e` with `secureChannelFactory` (no token), keeps the
   foreground gate, the one broker, `initialize` and `leaveComputer`.
6. **`src/pairing-flow.ts`** (new) — the reducer, `pairingView`, `failureFor`/
   `describePairingError` (exhaustive `Record`), and `runPairing` (fresh key,
   `onCompare` → `compare`, store write BEFORE `done`, Cancel closes the channel).
7. **`src/session-list.ts`**, **`src/computer-rows.ts`** — a caller-supplied
   diagnosis worded through `diagnosisMessage`; row states `ok|unreachable|
   revoked|maybe-reset|broken` with their actions.
8. **`src/routes.ts`** — `Pair` gains `{again?, againName?}`; `routeForStoreError`.
9. **`src/secure-kv.ts`** (new, the one native import), **`PairScreen.tsx`**,
   **`ComputersScreen.tsx`**, **`App.tsx`**.
10. Tests (see Gate): 6 new files, 5 updated, `e2e-strip-origin.test.ts` deleted.
11. Harness: `run.ts` (no proxy, no `EXPO_PUBLIC_*`), `hooks.ts` (+6 pairing
    hooks), `e2e/pairing.ts` and `e2e/pair-cli.ts` (new), `flows/_pair.yaml`,
    `pair-*.js`, flows 01–11 re-pointed, flows 12–17 new, `proxy.ts`/
    `strip-origin.ts` deleted, `e2e/README.md`.
12. `changelog.d/mobile-pairing-core.added.md`; this section.

### Gate (final, this branch)

```
$ bunx tsc --noEmit                        # clean
$ bunx tsc -p apps/mobile --noEmit         # clean
$ bun run lint                             # Checked 1185 files. No fixes applied. (0/0 — the §6 baseline)
$ bun test                                 # 8834 pass · 3 skip · 0 fail · 13 snapshots (634 files, 374s)
```

The 3 skips are the §6 opt-ins (live-k8s, live-docker, the real-socket keepalive).
`bun test apps/mobile` alone: **557 pass, 0 fail (44 files)**.

Mutation checks run (each pasted here as red-then-restored, §9 non-vacuity):

| # | Mutation | Test that went RED |
|---|---|---|
| M1 | private key also written into the index | `computer-store` "the private key lives ONLY in its computer's item" |
| M2 | `set` without `keychainAccessible` | "every set carries AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY" |
| M3 | add writes the index BEFORE the item | "add writes the ITEM before the index" |
| M4 | remove deletes the item BEFORE the index | "remove deletes the INDEX entry before the item" |
| M5 | an unknown `v` reads as empty | "an unknown version is StoreUnreadable and NOTHING is ever written" |
| M6 | a failed index read caught → `[]` | "a failed READ rejects, it is never an empty list" |
| M7 | `firstAnswering` continues past `unauthorized` | "STOPS on unauthorized without dialling the next" |
| M8 | the diagnosis counts a dial that never opened | "a dial that never opened does not count" |
| ME1 | the diagnosis fed a wrapped error (not the `ChannelError`) | `pairing-e2e` "a revoke while linked → … `revoked`" |
| ME2 | `done` dispatched BEFORE the store write | `pairing-e2e` "the Keychain write fails → `store`, `done` NEVER dispatched" |
| ME3 | `unauthorized` mapped to another pairing reason | `pairing-flow` "ChannelError{unauthorized} → expired, NOT revoked" |
| ME4 | Cancel only flips UI state (no channel close) | `pairing-flow` "Cancel closes the channel in flight" |
| ME5 | device-name validation not the protocol schema | "the device name is validated by the PROTOCOL schema" |
| ME6 | a shipped source reads `EXPO_PUBLIC_TENTACLE_*` | `pairing-guards` "no shipped source reads an EXPO_PUBLIC_TENTACLE_*" |

ME2 was VACUOUS on the first wording of its test (the happy path never reached the
store), so the test was rewritten to drive a store that refuses the write, and the
mutation then went red — recorded because a green test is not a proof (§9).

### Drift from the Implementation (and why)

1. **`e2e/pair-cli.ts` instead of static `packages/cli` imports.** The plan's
   tests and harness call `pairCommand`/`revokeCommand`/`resetCommand` directly.
   A static import from `apps/mobile/test/**` makes `tsc -p apps/mobile` compile
   `packages/cli` — which reaches `@tentacle/tui`, whose graph (`@tentacle/
   protocol` undeclared, JS-only `marked-terminal`) is not part of that project,
   so the app's own typecheck failed on code this task does not own. The loader
   uses COMPUTED specifiers (`new URL(...)`), which Bun resolves at run time and
   `tsc` does not follow. Verified: with a static import `tsc -p apps/mobile`
   fails; with the loader it is clean, and the same real CLI runs.
2. **`devices reset` needs a name.** `resetCommand` refuses without one ("name is
   missing or not printable"), so `pairing.reset()` passes `harness-mac`. (P6/P7
   said nothing about it; the plan's "`resetCommand` answering `y`" is not
   enough.)
3. **The `n` path reaches the app as `timeout`, not `declined`.** `pairCommand`
   DELETES the window's files on exit (`closePairing` in `finally`), so the
   daemon's poll usually finds the claim gone and answers `timeout` before it
   reads the `declined` decision. Both are refusals with "new code" copy and the
   same `pair-error-<reason>` shape, so 11b.1's `12-pair-declined` asserts the
   card/`no device` outcome, and `pairing-e2e` accepts either reason (it asserts
   the properties that matter: never `ok`, never stored). This is task 9's
   behaviour, not a 11b.1 change — recorded here because the plan's F-P7/Tests
   text says "`declined`".
4. **`firstAnswering` rethrows the LAST error unchanged** instead of an
   `AllAddressesFailed` wrapper: `link-machine.ts` classifies by `ChannelError`
   kind, and a wrapper hid the kind, so a dead address made the link report
   `unreachable` even when the real failure was a handshake violation (found by
   `pairing-e2e`'s reset case, which needs `unreachable` + the diagnosis streak,
   not a wrapper).
5. **`openComputer` takes an optional `diagnosis`.** The reset hint is "three
   failed attempts in a row", which a per-`openComputer` diagnoser can never
   reach (each failing `openComputer` throws, so no link survives to hold it).
   The app keeps ONE per computer (`App.tsx` `DIAGNOSES`).
6. **A reset is `unreachable`, confirmed empirically.** The plan (F-L3/P5) says
   the pinned-key mismatch arrives as a `closed`/`timeout` handshake failure, and
   the probe in `.tentacle/tmp/mobile-pairing-core/` (`zz-dbg3`) showed exactly
   `ChannelError{unreachable}` every time — `devices reset` also EMPTIES the
   registry, so the daemon's new key answers a handshake it cannot complete
   rather than a deny. The `maybe-reset` streak therefore works as designed.
7. **`e2e/pairing.ts` answers the prompt through `answer()`, after the SAS
   comparison.** The plan's `/pair/confirm` "answers per `answer`" in one step;
   splitting them (confirm → assert `pair-sas-${sas}` → answer) makes the ORDER
   the mockups' security property rather than a timing coincidence.
8. **Remove's confirmation is an in-app card, not `Alert.alert`.** The plan says
   "a native confirmation". RN's new architecture exposes no alert text or button
   to XCUITest, so a flow could never assert Remove's wording (which Owner Q5
   makes load-bearing: it names `tentacle devices revoke <name>`) or its effect —
   the same P9 reason every other value here is a testID. An in-app card with
   `computer-remove-confirm-<id>` / `-yes-` / `-cancel-` keeps the copy in the pure
   module (`removeMessage`) and the flow able to prove it. Verified on the
   simulator (`16-remove-computer` green).
9. **`removeMessage`, `brokenRow` and the row `action` field** are extra exports
   the plan did not name, so Remove's copy and a `broken` row's wording are
   decided in the pure module (`computer-rows.ts`/`ComputersScreen.tsx`), not in
   `App.tsx` (AGENTS §7).

### Maestro (iOS 26.5): PARTIAL — 5 of 6 new flows green, `15-revoked` blocked

Run as `bun run e2e:mobile --ios 26` (whole harness), then per-flow on a freshly
erased+booted simulator (the documented workaround for the driver wedge):

| Flow | Result |
|---|---|
| `01-shell` (through `_pair`) | **PASS** — a real pairing, both ends' compare code equal |
| `02-session-list`, `03-refresh` (through `_pair`) | **PASS** |
| `12-pair-declined` | **PASS** |
| `13-pair-expired` | **PASS** |
| `14-pair-bad-text` | **PASS** |
| `16-remove-computer` | **PASS** (Remove's card → `Pair`; relaunch still unpaired) |
| `17-persisted` | **PASS** (relaunch → `computer-<id>` and the list loads) |
| `15-revoked` | **BLOCKED, never asserted** — 5 attempts, 3 fresh boots |
| `05-daemon-down`, 12c's `06-…`–`11-…` | not reached in a whole-harness run (below) |

`_pair` green on the simulator is the load-bearing result: the phone generated
its key with `expo-crypto`, dialled `/e2e`, showed the SAS the terminal showed,
and the record survived into the list.

**Blocked by the simulator, not by the app.** `15-revoked` died with
`maestro.DeviceUnreachableException: Device became unreachable during inputText`
on every attempt — Maestro's XCUITest driver loses the simulator, which 12c
already documented (`mobile-session-view.md`, Execution: "A long Maestro session
degrades the simulator … recovering needs a shutdown + `simctl erase` + boot";
"every flow then fails identically"). In each attempt 15 got as far as
`pair-paste-input` being tappable and then the DRIVER died mid-`inputText`; the
step it never reached (`computer-state-<id>-revoked`) is driven end-to-end in the
gate by `pairing-e2e.test.ts` ("a revoke while linked → the link stops and the
diagnosis says `revoked`"), against a real daemon, a real `revokeCommand` and a
real socket.

The same wedge ended the whole-harness run after its first three flows, so
`05-daemon-down` and 12c's flows have no fresh green line in THIS run. They are
unmodified except for `_pair` replacing the dev-computer tap, and 12c's own
Execution records them green on the same commit's ancestor.

A CI leg should boot a simulator per run (12c's own note) — that is what would
make this table complete, and it is not something a task branch can fix.

Two harness defects the Maestro runs did surface (both fixed, both `pairing.ts`'s
own):
- **One window leaked between flows.** A flow that failed between `pair-start`
  and its answer left a window open; the next flow's `pair-start` was refused
  (F-H3's one-at-a-time is a rule *inside* a flow). `run.ts` now `stop()`s before
  each flow, and `stop()` reaches a `pair` this module no longer holds (a
  generation counter), so an abandoned `ask` answers `n` instead of blocking.
- **`devices revoke <name>` was ambiguous** across a config dir that accumulates
  a device per run (`iPhone`, `iPhone (2)`, …): the first attempt revoked a
  PREVIOUS run's phone and the phone under test stayed valid. Flow 15 now revokes
  the id `pair` reported for its own pairing (`/pair-device-id`).
- `changelog.d/mobile-pairing-core.added.md` uses the *plan's* 11b.1 text — the
  plan named the file `mobile-pairing-screen.added.md`; the slug rule (AGENTS §10,
  `docs/feat/changelog-fragments.md`) ties it to THIS branch/slice.
- **`devices reset` has no Maestro flow** (the plan gave it none; `maybe-reset`
  is `pairing-e2e`'s, as the plan's debt note says). Nothing changed there.
- The 13c `erased` simulator needed one rebuild after the screens changed
  (`expo prebuild` + `run:ios --configuration Release`); the harness does that
  itself per run, so no product impact.

## Review

#### Orchestrator decisions (owner night delegation 2026-11-14)

Owner asleep, delegated: every Owner question above is decided with its RECOMMENDED option. Implementation APPROVED. Ordering (orchestrator): 11b.1 starts after 13c merges (both add native deps → package.json/bun.lock), 14 after 11b.1, 11b.2 after 11b.1.

### Review — slice 11b.1 (`feat/mobile-pairing-core`, `git diff main...HEAD`)

*— claude-opus-5-5, 2026-11-14 (fresh context; a different model family from the executor)*

**Verdict: REQUEST-CHANGES** (1 HIGH, 1 MEDIUM).

**Gate (re-run here):** `bun test apps/mobile` 557 pass · 0 fail (44 files); `bun run typecheck` clean; `bun run lint` 1185 files, 0/0. Full `bun test` not re-run (Execution's 8834/3 skip taken on record). Maestro not re-run (simulator).

**Findings**

1. **HIGH: "Pair again" after a live revoke keeps the stale link.** `apps/mobile/App.tsx:644-648` (`onDone`) only runs `reload()` + `navigation.reset`. It never calls `LINKS.release(id)` or `DIAGNOSES.delete(id)`, which `onRemove` does (`:668-671`). `link-registry.ts:44-47` returns an `open` entry forever: a failed `get` is forgotten, a link that opened and later stopped is not. Scenario F-L1: the app is linked → `tentacle devices revoke` → the link goes `stopped` (`unauthorized`) and stays in `LINKS`, with the OLD device key in its `openComputer` closure (`connection.ts:186`) → the row says `revoked` → "Pair again" succeeds and the store now holds the NEW key → `loadRows` → `LINKS.get(id)` hands back the stopped link → `sessionList` rejects, and the diagnoser still says `revoked`. Owner Q7's recovery path (re-pair after revoke) does not recover until the app is killed. The same applies to any re-pair of a computer whose link is open. No test covers re-pair through the registry. Fix: release the link and diagnoser for `result.computer.id` before `reload()`, plus a regression test.
2. **MEDIUM: the "success resets the count" wiring is not pinned.** I deleted `diagnosis.ok()` in `connection.ts:225`. `connection.test.ts`, `pairing-e2e.test.ts`, `link-diagnosis.test.ts` and `address-dial.test.ts` all stayed **green**: only the reducer's `ok()` is tested, not that the link calls it. Without that call, a `revoked`/`maybe-reset` verdict outlives a successful redial, and streaks add up across healthy periods, giving a false "may have been reset" (F11 says "any success resets the count"). This is a §9 non-vacuity gap on a load-bearing path.

**Mutations (mine; each reverted, `git status` clean afterwards):** `firstAnswering` ignores `memory.lastGood` → RED (`starts at the remembered good address`). `diagnosis.ok()` removed → GREEN, which is finding 2.

**Attacks tried, no finding:**
- §7 one session path: still the single `RemoteClient` + `channelFactory` decorator, so no second session code path. The gate wraps the one factory.
- Single broker: still `createLinkBroker()` per link. Pairing opens no broker.
- Key storage: the private key is only in the per-computer item. Every `set` carries the injected `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. Write order is item→index on add and index→item on remove. An index with an unknown `v` blocks `add`/`remove`, because both run `readIndex` first.
- `unauthorized` stops the address loop (P5). A pairing `unauthorized` maps to `expired`, not `revoked` (P4). A late cancel is harmless, because `onCancel` unmounts the route.
- The harness hooks bind to `127.0.0.1`. No `EXPO_PUBLIC_TENTACLE_*` is left in the app.

**Executor behaviour:** a thorough and honest Execution. Drift is recorded with reasons, ME2's first vacuous test is admitted, and the blocked `15-revoked` flow is stated, not glossed. The `15-revoked` gap matters more after finding 1. That flow stops at `computer-state-<id>-revoked` and never exercises "Pair again", and `pairing-e2e` calls `openComputer` directly, bypassing `LINKS`. So the one path that breaks was covered by neither.
