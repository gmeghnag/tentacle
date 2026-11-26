# feat/connect-via-relay — drive an unreachable `serve` from the laptop TUI through the relay

> **Status:** context · **implementation (APPROVED — owner answers 1-6 + orchestrator decisions below)** · execution · review
> **Branch:** `feat/connect-via-relay` (promoted from the eval of the same slug; the eval's Context/Review are kept below)
> Type: feat · Size: M (two slices, one branch) · Blast: load-bearing (a new long-lived laptop credential that grants code execution on the `serve` host; touches the `connect` entry) · Suited: Opus execution (both slices), mandatory fresh-context Opus security review
> **Changelog:** `changelog.d/connect-via-relay.added.md`

## Context

*— claude-opus-5-5, 2026-11-26*

**Question (owner, 2026-11-26).** `tentacle connect` accepts only a reachable
`ws(s)://host:port` (`packages/cli/src/main.ts:454`). Can the laptop TUI drive a
`serve` on a machine with no route and no open port, the way a paired phone does
through `relay.tentacle.so` (serve dials OUT, the relay sees only ciphertext)?
Owner: «valutiamo: se non è cosa [the phone's pairing/relay as just another
DuplexChannel under the one session path], possiamo pensare anche a un diverso
percorso di sessione». An earlier decision parked exactly this: device-pairing
owner Q5 «Laptop `connect` over device keys — stays token/TLS, revisit with the
relay» (`docs/feat/device-pairing.md:574-576`).

**What the code does today (only what the decision stands on).**

- **The phone already IS the one session path.** The app builds the same
  `RemoteClient` ↔ `Connection` stack as the TUI, over
  `secureChannelFactory(dial-to-/e2e, { staticKey: this phone's key for this computer })`
  (`apps/mobile/src/connection.ts:2-11`, `:24`, `:30`). It speaks the full JSON-RPC
  protocol, not a mobile subset or projection.
- **The relay is a byte splice.** Routes: `/v1/daemon` (the serve's control socket),
  `/v1/accept` (one data leg per stream), and `/d/<id>/e2e` (the phone's leg).
  The relay holds no key and authorises nobody (`apps/relay/src/server.ts:1-21`).
  Frames are capped at 96 KiB before any handler runs (Noise messages are ≤ 65 535 B),
  and a leg that stops reading is closed at the backpressure ceiling
  (`server.ts:148-172`). Dials are limited to 30 per minute per IP
  (`relay-core.ts:47`), and a dial is held while no daemon is registered (`relay-core.ts:584-594`).
- **Serve side.** The relay leg is a plain `ByteCarrier` handed to `acceptDevice`.
  That is the same Noise handshake, device registry, `Connection`, revoke handle
  and single broker as the direct `/e2e` route: «This file adds a transport and
  nothing else» (`packages/daemon/src/relay-link.ts:4-18`, `:772-776`).
  `acceptDevice` builds the unchanged `Connection` with a `device` principal
  (`device-accept.ts:113`, `:234`).
- **Crypto.** Noise `IK_25519_ChaChaPoly_SHA256` (`packages/transport/src/noise.ts:13`).
  The initiator pins the computer key from the pairing payload. A replayed
  message 1 builds nothing and records nothing (`device-accept.ts` header, F4/P2).
- **What a device may do compared with a `connect` token client.** Both run the
  same method switch. A `pairing` principal may only call `device/pair`
  (`connection.ts:186-190`, `:387-399`). The only differences for a `device` are:
  - push and live-activity registration (`:609-675`);
  - discovery limited to its own daemon, because a pairing is per project (`:703-711`);
  - a `deviceId` on its attachment, which push suppression uses (`:1092-1095`).

  The phone can therefore already answer permissions and drive turns. A device
  already has the same power as a token client.
- **`connect` today.** Auth is a bearer token checked at the HTTP upgrade with
  `tokensMatch` (`ws-server.ts:214-221`, `:322-324`). That is one shared secret,
  with no per-client revoke. The device route `/e2e` needs no token: the handshake
  is the authentication (`ws-server.ts:62-69`). `connectTui` needs only
  `deps.dial: (url, opts) => () => Promise<DuplexChannel>`
  (`packages/cli/src/connect.ts:238`, `:266-269`). It hands that factory to
  `RemoteClient` as `channelFactory` (`:290-292`), next to the ONE
  `PermissionBroker` (`:265`).
  - `secureChannelFactory(dial, {…})` returns exactly that shape
    (`packages/client/src/secure-channel.ts:44-57`).
  - A Bun byte-carrier dialer already exists (`packages/client/src/ws-channel.ts:270-276`).
  - The pairing client `pairDevice` lives in `@tentacle/client/pairing`, not in the
    app (`packages/client/src/pairing.ts:1-23`).
  - `tentacle pair` already prints a pasteable payload line next to the QR
    (`packages/cli/src/pair.ts:2`, `:83`).
- **Pairing and revocation are host-terminal acts.** `tentacle pair` opens a
  window and shows the SAS, and only the host's `y` turns a claim into a device
  (`pair.ts:1-16`). `tentacle devices revoke` edits the registry on the host.
  Running daemons poll it and close the live sockets of a revoked device
  (`packages/cli/src/devices-cmd.ts:1-17`), including a relay connection
  (`packages/daemon/test/relay-link.test.ts:550`). No RPC method revokes or adds
  a device: the protocol's only `device/*` methods are `device/pair` and the push
  and live-activity ones (`packages/protocol/src/methods.ts:281-309`).

**Repro / evidence (2026-11-26, on `main` dc395a5a).** The capability is missing:
`connect` takes only `ws(s)://host:port` (`main.ts:454`). The load-bearing seam
is shown working in Bun by the existing suites: the real `RemoteClient` ↔ real
`Connection` over Noise runs a whole turn with frames over 64 KiB, redials with a
fresh handshake and resumes, stops on an authenticated deny, gives a clean
`VersionMismatch` inside the channel, and keeps a concurrent request moving during
a long prompt. The relay leg lands in `acceptDevice`, and revoke closes it.

```
$ bun test packages/client/test/secure-channel.test.ts packages/daemon/test/relay-link.test.ts
 37 pass
 0 fail
 117 expect() calls
Ran 37 tests across 2 files. [1132.00ms]
```

## Implementation

*— claude-opus-5-5, 2026-11-26* · **APPROVED** (owner delegated the details; no
choice below weakens an AGENTS §7 trust rule, so there are no owner questions).

Scope, exactly as the owner answered (§ Owner answers below): `connect` gets a
**device mode**. Pair once with `tentacle connect --pair '<payload>'`, then
`tentacle connect <name>`. The dial tries the direct addresses first and the
relay last. The laptop gets the same rights as a phone, per project. Its key
lives in the macOS Keychain, else in a `0600` file, one key per computer.
Approval happens only on the serve host's terminal. **Out of scope:** remote
revoke (owner Q4, a follow-up task), any daemon / relay / protocol / mobile /
`@tentacle/client` change, and `PROTOCOL_VERSION` (no `protocol.d/` note).

### Load-bearing assumption

*A laptop that dials a paired computer's `/e2e` address (direct, or the relay's
`/d/<id>/e2e`) with its device key lands in the SAME `acceptDevice` →
`Connection` as a phone. `connectTui` needs nothing but a
`() => Promise<DuplexChannel>`, and `secureChannelFactory` already returns one.*
Verified on this branch (82970b16):

- `connectTui` takes the channel from one injected seam,
  `deps.dial: (url, options) => () => Promise<DuplexChannel>`
  (`packages/cli/src/connect.ts:238`). It calls that seam once
  (`connect.ts:266-269`), dials (`:274`), and hands the SAME factory to `RemoteClient` as
  `channelFactory` (`:290-292`), next to the ONE broker (`:265`). Nothing
  else in `connectTui` reads the transport. `options.url` is only display text
  (`:358` `cwd`, `:429` the resume hint).
- `secureChannelFactory(dial, options): () => Promise<SecureChannel>` dials a raw
  `ByteCarrier` and runs the Noise initiator over it. A `NoiseError` becomes a
  `ChannelError`, and only `denied` becomes `unauthorized` (terminal)
  (`packages/client/src/secure-channel.ts:24-33`, `:44-57`).
- The phone does exactly this composition today and passes the result to
  `RemoteClient` as its channel factory:
  - `webSocketCarrierFactory` opens each address (`apps/mobile/src/connection.ts:335`);
  - `secureChannelFactory(async () => channel, { staticKey: deviceKey, remoteStatic, random })`
    runs on the race's winner (`:361-365`);
  - `firstAnswering(computer.addresses, steps, memory)` races the addresses (`:389`);
  - the result goes into `new RemoteClient(channel, broker, …)` (`:410`).
- Serve side, the relay leg calls the same `acceptDevice` as the direct route:
  «The SAME device path the direct `/e2e` route runs»
  (`packages/daemon/src/relay-link.ts:772-776`). `acceptDevice` builds the
  unchanged `Connection` on the resolved secure channel, with a `device`
  principal (`packages/daemon/src/device-accept.ts:231-238`).
- In Bun, the eval's run showed a real `RemoteClient` ↔ real `Connection` over
  Noise working (37 pass, § Context). A real `startDaemon` already accepts a
  paired key on `/e2e` (`packages/cli/test/serve-devices.test.ts:197`).

**Conclusion:** the change is a laptop-side transport (a `deps.dial`
implementation), a credential store and CLI wiring. No second session path.

### Preconditions

- **P1, one session path (§7).** Device mode replaces only `deps.dial`.
  `RemoteClient`, `Connection`, redial and re-attach are untouched
  (`connect.ts:266-292`).
- **P2, single broker (§7).** `connectTui` builds the ONE `PermissionBroker`
  (`connect.ts:265`) and hands it to `RemoteClient` (`:290`). This plan does
  not touch it. Device mode must not build its own client or broker.
- **P3, trust bits.** `connectTui` sets `daemonWakes` and `sharedAutoAccept` for a
  `serve` (`connect.ts:301`, `:306`). The phone sets both for the same reason
  (`apps/mobile/src/connection.ts:57-73`). A device route exists only on a
  `serve`, so the bits stay correct. No new trust bit is added.
- **P4, pairing client is shared and Bun-agnostic.**
  `pairDevice({ payload, deviceKey, name, dial, random, onCompare })`
  (`packages/client/src/pairing.ts:52-80`, `:85`) races the payload's addresses
  and reports the SAS through `onCompare` BEFORE `device/pair` is sent. The
  payload parser and its fields `key`, `computer`, `code`, `addresses` and
  `project?` (`packages/protocol/src/pairing.ts:143-159`, `:211`) already exist.
  `DevicePairResult` is `{ deviceId, computer, project? }`
  (`packages/protocol/src/device.ts:79-86`). The CLI already imports
  `@tentacle/transport/noise` (`packages/cli/src/pair.ts:46`) and depends on
  `@tentacle/client` and `@tentacle/transport` (`packages/cli/package.json:16`, `:26`).
- **P5, keys.**
  - `generateStaticKeypair(random)` and `systemRandom` exist
    (`packages/transport/src/noise-channel.ts:131`, `:58`).
  - The phone makes a FRESH keypair for each pairing
    (`apps/mobile/src/pairing-flow.ts:547`), stored per record (`computer-store.ts:114`).
  - The host's own store is `<configDir>/devices/` (`packages/daemon/src/device-store.ts:124`).
    The laptop's client store must not collide with it, because a laptop can be
    a `serve` host too.
- **P6, address refresh.**
  - A device sees only its own daemon in `daemon/discover`
    (`connection.ts:703-711`, eval Context).
  - `RemoteClient.discover(listener)` exists (`packages/client/src/remote-client.ts:1379`).
  - The phone folds the result with `discoveryPatch` (`apps/mobile/src/discover-fold.ts:31-68`)
    on top of the shared rule `mergeAddresses` (`packages/client/src/discovery.ts:150`).
- **P7, address race.**
  - `firstAnswering(addresses, steps, memory)` uses its stagger to put the
    relay last when the list order does: `tentacle pair` already lists direct
    addresses before relay ones (`packages/cli/src/pair-addresses.ts:26-34`, `:139`).
  - An `unauthorized` stops the loop (`packages/client/src/address-dial.ts:119`).
- **P8, CLI shape today.**
  - `ARGS.connect` takes `token`, `token-command`, `ca-cert`,
    `insecure-skip-tls-verify`, `--resume` and `--continue`, with exactly one
    positional (`packages/cli/src/flags.ts:91-97`).
  - The dispatch is at `packages/cli/src/main.ts:813-855`.
  - `resolveTls` refuses TLS flags without a `wss://` URL (`flags.ts:588-601`).
  - The help lines are at `main.ts:383` and `:454`.
- **P9, no raw terminal writes under Ink (§7).** `connectTui` routes in-session
  errors through `bufferedErrorSink` (`connect.ts:282`).

### Orchestrator decisions (owner delegated; recommended option taken)

- **D1. Store layout: one file per paired record, no index.**
  - Records live at `<configDir>/connect/computers/<name>.json` (dir `0700`,
    file `0600`).
  - A record holds:
    - `v: 1`;
    - `name`;
    - `id`, a random 16-byte hex string, which is the key's handle;
    - `computer`, the host's display name;
    - `computerKey`, base64url, pinned;
    - `deviceId`;
    - `project?`, `{cwd, label}`;
    - `addresses`;
    - `lastAddress?`;
    - `keyStore`, `"keychain" | "file"`.
  - A record is CREATED with `wx`, so `EEXIST` means the name is taken: try
    `<name>-2`, `-3`, and so on. The filesystem therefore enforces unique names,
    and two concurrent `--pair` runs can never lose each other's record.
  - A refresh rewrites only its own file (tmp + `rename`). Two `connect`s
    refreshing one record converge to last-writer-wins on `addresses` and
    `lastAddress`; both values are valid merges. The private key is never in
    the record.
  - *Why:* an index would need a lock (a read-modify-write race between a
    refresh and a pair). Per-record files make that race impossible.
- **D2. Key store.**
  - On `darwin`, keys go to the macOS Keychain: service `tentacle.connect`,
    account `<record id>`. They are written through `/usr/bin/security -i`
    with the command on **stdin**, so the secret never appears in argv (§7
    rule: secrets never in argv, they are visible in `ps`). They are read with
    `security find-generic-password -s … -a … -w`; the secret comes back on stdout.
  - On any other platform, or when the Keychain write fails at pair time:
    `<configDir>/connect/keys/<record id>.key`, `0600`, in a `0700` dir.
    Falling back is said in ONE line.
  - The record names its store (`keyStore`). A read never falls back silently:
    a missing key is an error that says "pair again".
  - *Honest property:* an item created by `security` trusts `/usr/bin/security`,
    so any process running as the same user can read it without a prompt.
    Against same-user malware it equals the `0600` file. What it adds: the key
    is encrypted at rest while the keychain is locked, and it is never in
    dotfile syncs or backups of `<configDir>`. A per-app ACL would need a
    signed native helper; that is out of scope and recorded as debt.
  - **First step of Slice 1:** check `security -i` stdin storage empirically,
    on a throwaway keychain, never the login one. The planner's attempt needed
    a permission this session could not grant. The script is in § Tests T0.
    If it does not work, Keychain support is dropped from v1 and every key is a
    `0600` file. The owner's "else a 0600 file" allows that; record it as drift.
- **D3. One fresh key per pairing.** As on the phone (P5). This is stricter than
  "one key per computer": no key is ever shared between computers or between
  projects. A per-project pairing is a new record with a new key.
- **D4. Device name shown on the host:** `os.hostname()`, trimmed to
  `PAIRING_COMPUTER_NAME_MAX`. If it fails `isPairingName`, the name is
  `laptop`. There is no flag. The host's `y` prompt shows it next to the SAS.
- **D5. The local record name** (what `connect <name>` takes) is
  `project.label` from the pairing result. If that is absent, it is the payload's
  `computer`, made into a slug (`[a-z0-9._-]`, ≤ 64 chars). It is deduped by D1.
  `--pair` prints the result: `paired as '<name>' — connect with: tentacle connect <name>`.
- **D6. `--pair -` reads the payload from stdin.** This keeps the one-time code
  out of shell history and `ps`. It is optional: the owner's literal form,
  `--pair '<payload>'`, is the documented one. Inline is acceptable because the
  code is single-use and expiring, and a host `y` after a SAS compare gates it.
- **D7. `connect --forget <name>`** deletes the record file, then the key
  (key-rotation story, eval § Failure modes). It prints the `deviceId` and
  `tentacle devices revoke <deviceId>` to run on the host, because forgetting on
  the laptop does not revoke on the host. There is no `--list`: an unknown name
  prints the known names.
- **D8. Positional routing.**
  - A positional matching `^wss?://` is the existing token path, unchanged.
  - Anything else is a record name.
  - With a name, `--token`, `--token-command`, `--ca-cert` and
    `--insecure-skip-tls-verify` are refused with one line: the Noise pin
    replaces them.
  - `--pair` and `--forget` take no positional and no other flag.
- **D9. Discovery refresh** happens after the first `initialize`, through a new
  optional `ConnectDeps.onClient?(client: RemoteClient): void` hook. Device mode
  calls `client.discover()` there and folds the result with a CLI-side pure
  `foldDiscovery` (P6's rule: `self` only, same `cwd` only, `mergeAddresses`, and
  `undefined` when nothing changed). It writes the record (D1).
  - A write failure goes to the sink (P9), never to stderr.
  - `lastAddress` is persisted the same way (best effort, after a dial is won).
  - *Why not lift the phone's `discoveryPatch`:* it is typed on the app's
    records (`discover-fold.ts:18`). Moving it touches `apps/mobile` and its e2e
    gate for ~20 lines. Recorded as debt: unify later.
- **D10. Help and docs.** The `connect` help (`main.ts:383`, `:454`) gains the two
  device lines. It also gains ONE line naming the zero-code fallback (a tailnet
  plus `serve --address`), which the eval asked for. A README sentence goes in
  the `connect` paragraph.

### Design

```
connect --pair '<payload>'          connect <name>
  parsePairingPayload                 readRecord(name) → record + KeyStore.get(id)
  generateStaticKeypair               deviceDial(record, key) ─┐
  KeyStore.put(id, priv)   (1)          firstAnswering(addresses, steps, memory)
  pairDevice({..., perProject: true,      open:   webSocketCarrierFactory(addr)()
              onCompare→print SAS})
  createRecord(wx)          (2)           confirm: secureChannelFactory(→carrier,
  print name                                       {staticKey, remoteStatic, random})()
                                       connectTui({url: name}, err, {dial: () => deviceDial, startTui,
                                                    onClient: refresh addresses})
```

- **Order (pair):** key first, then pair, then record. If pairing fails, the key
  is deleted (best effort). If the record write fails after a successful pair,
  the CLI prints the `deviceId` and the revoke command for the host. No crash
  can leave a listed record without a key; at worst an orphan key remains, which
  is harmless.
- **`connect <name>`:** `ConnectDeps.dial` is a closure that ignores its
  `(url, options)` and returns the device factory. Everything after is today's
  `connectTui`: the TUI, `--resume`, `--continue`, `/sessions`, the exit line
  (`tentacle connect <name> --resume <id>` is correct, because `url` is the
  name), and quitting only detaches.
- **Pure vs I/O split (§7 logic in pure modules):**
  - pure (no I/O): argv routing (D8), record validation and parsing, the name
    slug and dedupe, `foldDiscovery`, and the pre-mount error hint mapping;
  - thin I/O: the record files, the Keychain and file key stores (an injected
    `run(cmd, args, stdin)`), and `deviceDial` (injected carrier factory and random).

### Files (dependency order; no protocol/daemon/client/relay/mobile change)

**Slice 1: the credential and record stores (pure plus file I/O, no network)**

1. `packages/cli/src/connect-store.ts` (new): records (D1, D5, D7). It exports
   `createRecord`, `readRecord`, `listRecordNames`, `writeRecord`,
   `removeRecord`, `slugName` and `parseRecord`. An unknown `v` or an unreadable
   file is refused, and the file is never written.
2. `packages/cli/src/connect-keys.ts` (new): `KeyStore { put, get, remove }`
   with two implementations, `keychainKeyStore(run)` and `fileKeyStore(dir)`
   (D2). `run` is injected; production uses `Bun.spawn` with `stdin` piped.

**Slice 2: dial, pair and CLI**

3. `packages/cli/src/connect-device.ts` (new):
   - `deviceDial(record, deviceKey, deps)`, which returns `() => Promise<DuplexChannel>` (Design);
   - `foldDiscovery` (pure, D9);
   - `pairLaptop(payloadText, deps)` (pairing order, D4-D6);
   - `deviceConnectError(error, record)`, which maps a pre-mount failure to
     one-line hints: `unauthorized` gets "this laptop's key was refused
     (revoked?) — pair again", and unreachable gets "no address answered — is
     `serve` running there?".
4. `packages/cli/src/connect.ts`: add the optional
   `ConnectDeps.onClient(client, report)` (`report`: the error sink). It is
   called once, after `client.initialize()` and before Ink mounts (§7 terminal
   rule).
5. `packages/cli/src/flags.ts`: `ARGS.connect` gains `values: pair, forget` and
   `positional: { min: 0, max: 1 }`. The "exactly one target" rule moves to the
   pure D8 router.
6. `packages/cli/src/main.ts`: the dispatch at `:813` goes through the D8 router.
   The device branch builds `KeyStore` (with a `main` test seam for it, like the
   `logs --connect` dial seam at `:633`) and calls `connectTui` with the device
   dial. Help is updated at `:383` and `:454` (D10).
7. `README.md`: one sentence in the `connect` paragraph (D10).
8. `changelog.d/connect-via-relay.added.md`: one bullet.

### Failure modes (each with how state converges)

| # | Case | Behaviour |
|---|---|---|
| F1 | Record file has an unknown `v`, or is unreadable or invalid | Refused with its path. It is never written or deleted by this build (§7 on-disk rule). Other records still work. |
| F2 | Key missing: the Keychain item was deleted, the file is gone, or `security` exits non-zero (a locked keychain over ssh) | `connect <name>` exits 1: «key for '<name>' unavailable (<store>) — pair again, then `tentacle devices revoke <deviceId>` on the host». No silent switch to the other store. |
| F3 | Pair refused (wrong or expired code, used, host `N`) | The `PAIRING_REFUSED_MESSAGES` line. The key just stored is removed and no record is written. A retry is a fresh `tentacle pair` on the host. |
| F4 | Pair OK, record write fails (disk full, permissions) | Prints `deviceId` + «paired on the host but not saved here — revoke it there: tentacle devices revoke <id>». The key is removed. Nothing usable is left half-done. |
| F5 | Two `--pair` runs at once with the same name | `wx` create: the second gets `-2` (D1). No record is lost. |
| F6 | Revoked laptop | Pre-mount: `denied` → `unauthorized` → the hint, exit 1. Mid-session: the existing `stopped` link with no redial storm (`secure-channel.test.ts:159`). |
| F7 | Relay down, serve not running, or relay `4404` | Pre-mount: `ChannelError` unreachable → the hint. Mid-session: `RemoteClient` redials through `firstAnswering`, and the turn keeps running on the serve. A direct address that answers wins the race. |
| F8 | Host identity reset (`devices reset`) | The pinned `remoteStatic` mismatches → `handshake-failed`/`closed`, which is transient. Pre-mount: the first dial fails → exit 1 with a hint that also names "computer key changed? pair again". Mid-session: transient retries, as on the phone. Re-pairing is the honest fix (eval F11). |
| F9 | Address change: new LAN IP, port, or relay id/secret | D9 refresh on every connect folds `self`'s announced addresses, so the next connect dials them. If every stored address is dead before any refresh: F7, then re-pair. |
| F10 | Version skew | Payload `v` refused by `parsePairingPayload`. E2E version: `rejected` with `remoteE2eVersion`, shown. `PROTOCOL_VERSION`: a clean `VersionMismatch` at `initialize` (`secure-channel.test.ts:204`). Record `v`: F1. |
| F11 | Name that is also a URL, or empty | D8: `^wss?://` is the token path. An empty name or a missing positional without `--pair`/`--forget` is a usage error. An unknown name prints the known names. |
| F12 | Phone and laptop on one session | Unchanged (eval § Failure modes): first answer wins, `askedOn` per ask. |
| F13 | Refresh write fails during the TUI | Reported through the sink (P9), flushed after unmount. The connection is unaffected and the old addresses are kept. |
| F14 | Relay rate limit (30 dials/min/IP) | The existing `RemoteClient` redial backoff. No new dial loop is added. |

### Tests (red before green; the executor creates each new module as a stub that returns the wrong value first, so RED is on the property's assertion, not an import error, AGENTS §4)

- **T0 (Slice 1, step 1, an empirical gate, not a suite test):** run
  `.tentacle/tmp/connect-via-relay/kc.sh` (below). It must print the secret
  back from `find`, a non-zero `missing rc`, and `del rc=0`. Paste the output
  into Execution. If it fails, apply D2's fallback.
  ```sh
  KC="$(pwd)/scratch.keychain-db"; rm -f "$KC"
  security create-keychain -p scratchpw "$KC" && security unlock-keychain -p scratchpw "$KC"
  printf 'add-generic-password -U -s tentacle.connect.test -a rec1 -w c2VjcmV0 "%s"\n' "$KC" | security -i
  security find-generic-password -s tentacle.connect.test -a rec1 -w "$KC"; echo "find rc=$?"
  security find-generic-password -s tentacle.connect.test -a missing -w "$KC"; echo "missing rc=$?"
  security delete-generic-password -s tentacle.connect.test -a rec1 "$KC" >/dev/null; echo "del rc=$?"
  security delete-keychain "$KC"
  ```
- **`packages/cli/test/connect-store.test.ts`** (temp `configDir`):
  - modes `0700`/`0600`;
  - `wx` dedupe gives `-2` (F5);
  - an unknown `v` is refused and its bytes are untouched after every API call (F1);
  - `writeRecord` never adds a key field;
  - `slugName` bounds;
  - `--forget` order: record then key.
- **`packages/cli/test/connect-keys.test.ts`** (fake `run`, NEVER the real Keychain):
  - the secret's bytes appear in NO argv element of any `run` call, only in stdin.
    Mutation check: put it on argv and the test must fail.
  - a missing item becomes the F2 error;
  - Keychain `put` failure → file fallback plus one notice line;
  - the file store writes mode `0600`.
- **`packages/cli/test/connect-device.test.ts`:**
  - **e2e, the load-bearing property:** a real `startDaemon` on loopback with a
    device registered through the store API, using the
    `serve-devices.test.ts:197` harness. A record points at `<url>/e2e`, then
    `connectTui` runs with `deviceDial` and a fake `startTui` that does
    `initialize` + `session/list`. Assert it succeeds, AND that
    `daemon/discover` returns only `self`, which proves the `device` principal.
    Mutations: a wrong device key must give `unauthorized`, and a wrong pinned
    computer key must fail the handshake.
  - **order:** fake carriers record dial order. A dead direct address falls
    back to the relay-shaped address, and a live direct address wins before the
    relay is opened (staggered). `unauthorized` on the first address means no
    second address is tried (P7).
  - **`foldDiscovery`:** `self` only; a different `cwd` → `undefined`; unchanged
    → `undefined` (one write per change).
  - **`pairLaptop`** (fake `pairDevice` deps):
    - the SAS is printed before the claim resolves;
    - F3: key removed, no record;
    - F4: key removed and the message names the `deviceId`;
    - the key is `put` BEFORE `pairDevice` runs.
  - **`deviceConnectError`:** the F6, F7 and F8 hints.
- **`packages/cli/test/connect.test.ts`** (existing): `onClient` is called once,
  after `initialize`, before `startTui`. The existing token tests stay green
  (the URL path is unchanged).
- **Main dispatch** (a new `connect-device-main.test.ts`, through `main` with
  the KeyStore seam):
  - `connect --pair X name` → a usage error;
  - `connect name --token t` → refused (D8);
  - `connect wss://h:1` → still the token path;
  - `connect nope` lists the known names;
  - `--pair -` reads stdin.
- **Relay leg:** no new suite test. The relay → `acceptDevice` path is already
  pinned (`relay-link.test.ts:550`), and from the laptop the relay is just one
  more `/e2e` address. Executor: if `relay-link.test.ts` has an in-process relay
  that a plain `WebSocket` can dial at `/d/<id>/e2e`, add ONE `deviceDial` test
  through it. Otherwise say so in Execution (unverified: the live relay hop,
  verified by the owner's live test before merge).
- **Gate:** `bun run check`, against the clean lint baseline.

## Execution

*— claude-sonnet-5-5, 2026-11-26* (the metadata line suggested Opus execution;
this ran on Sonnet 5.5, so weigh that in the mandatory security review).

**Load-bearing check re-run:** `bun test` on `secure-channel`, `relay-link` and
`serve-devices` → `46 pass, 0 fail`. The cited `connect.ts` lines matched.

**⚠ T0 NOT RUN (open before merge).** Running the throwaway-keychain script
needed a permission this session did not get; it was not worked around, and no
`security` command ever ran. So `security -i` stdin storage and the exit code
`44` for a missing item are **unverified**. Run
`sh .tentacle/tmp/connect-via-relay/kc.sh` (the T0 script, plus one add to a
bad keychain path): `find` must print `c2VjcmV0`, `missing rc` non-zero,
`del rc=0`. Drift: Keychain support was **kept**, not dropped, because `put` now
reads the item back and throws on any mismatch, so a `security` that stores
nothing falls back to the `0600` file with one notice line. If T0 fails, drop
the `keychain` entry in `defaultKeyStores`.

**As built.**
- Slice 1: `cli/src/connect-store.ts`, `cli/src/connect-keys.ts`.
- Slice 2: `cli/src/connect-device.ts` (routing, dial, hints, refresh, pair,
  connect, forget); `connect.ts` `ConnectDeps.onClient`; `flags.ts`
  `ARGS.connect` + `USAGE`; `main.ts` dispatch, `connectKeys` seam, help;
  `README.md`; `changelog.d/connect-via-relay.added.md`.
- No protocol, daemon, client, relay or mobile change; `protocol.json` untouched.

**Drift from the plan.**
1. `pairDevice` is called with `perProject: true`. The plan omitted it; a current
   daemon then refuses with `update_app` (shown by mutation below).
2. `onClient(client, report)`: the second argument is the error sink, which the
   F13 refresh failure has no other way to reach.
3. A remembered **relay** `lastAddress` does not start the race (owner: direct
   first, relay last); a remembered direct one does.
4. The device dial bounds the OPEN at `PAIRING_OPEN_DEADLINE_MS` (15 s), else a
   hanging TCP connect holds the first dial.
5. `foldDiscovery` adopts the announced project when a record has none.
6. `writeRecord` also refuses a forgotten or replaced record.
7. Tests: pure and pairing cases are in `connect-pair.test.ts`. Added, not in the
   plan: a real `serve` + `tentacle pair` + `pairLaptop` + connect e2e; the
   in-process relay leg through `deviceDial`; `spawnRun` on `cat`/`false`.

**Red first** (stubs returning wrong values): store 12/14 red (this module was
written before its stub, which was swapped in afterwards); keys 13/14; device
11/11 (mostly the stub's throw, not an assertion); pairing red; `onClient` red on
its order assertion; main dispatch 8/10 before wiring.

**Mutations** (each applied, seen red, reverted):

| Break | Red test(s) |
|---|---|
| secret added to `security` argv | "NO argv element of any call" |
| `isTerminal: () => false` | "a refused key stops the race" |
| relay `lastAddress` allowed to start | "remembered RELAY address" |
| key not removed on a failed pair | F3, "unreachable host removes the key" |
| `onClient` before `initialize` | the `onClient` test |
| `perProject` removed | real pairing: «this computer pairs per project» |

A wrong device key (`unauthorized`) and a wrong pinned computer key (handshake
failure) are tests against a real daemon.

**Checks.** Nine covering files: `156 pass, 0 fail`. `biome check
packages/cli/src packages/cli/test`: clean. A `tsc` scoped to the `connect*`
files and `main.ts` reported nothing in them (two errors in unrelated files,
from the narrow include). Full gate: **not run here** (orchestrator's script).

**Unverified:** the live `relay.tentacle.so` hop and a real Ink TUI on the device
path (`startTui` is faked) → the owner's live test.

**Debt.** A TLS failure on a `wss://` direct address still gets `connectTui`'s
`--ca-cert` hint, a flag device mode refuses (`NODE_EXTRA_CA_CERTS` works).
Ctrl+C during pairing leaves an orphan key. Re-pairing a project makes
`<name>-2`. `foldDiscovery` duplicates the phone's `discoveryPatch`. A Keychain
item made by `security` is readable by any same-user process (D2).

## Review

*— claude-opus-5-5, 2026-11-26*

### Options

**A. Device-mode `connect`: the phone's transport as one more `DuplexChannel` (recommended).**
The laptop becomes a paired device, exactly like a phone.

- **Pairing, once.** The owner runs `tentacle pair` on the host and pastes the
  payload line on the laptop. `pairDevice` runs the exchange and the host answers `y`.
- **Connecting.** `tentacle connect <computer>` builds
  `secureChannelFactory(webSocketCarrierFactory(addr), { staticKey, remoteStatic })`
  over the stored addresses: direct `/e2e` first, relay last, with the phone's
  staggered `firstAnswering`. It passes the result as `deps.dial`.
- **Changes.** No daemon, relay or protocol change. The new code is laptop-side
  only: a key store, a small store of paired computers and the CLI wiring.
- **What stays the same.** The single broker and the persistence rules: `connect`
  keeps no laptop copy, the serve's log is the truth. The model also stays on
  the serve, as it does today. The token path is untouched.
- **Bonus.** A LAN `connect` with no token and a per-device revoke (direct `/e2e`).
- **Cost.** About M.
- **What changes for the laptop.** A per-project pairing like the phone's. As a
  device, the laptop sees only its own daemon in discovery (`connection.ts:703-711`).

**B. A different session path.** Two variants:

- **(B1) A mirrored terminal (PTY) over the relay**, like ssh or mosh: the TUI
  runs on the host and the laptop only carries terminal bytes.
  - Every keystroke and every repaint pays the relay round trip. With A the TUI
    renders locally and only prompts and deltas cross.
  - It loses laptop-local input: image paste, voice, clipboard, the laptop's theme and config.
  - It needs a new byte protocol and its own authentication, which is a second channel to secure.
- **(B2) A laptop-specific RPC projection.** Nothing needs it, because the phone
  already speaks the full protocol.

**Verdict on B: not justified.** A breaks nothing and adds no session code. The
§7 one-session-path invariant holds as it is: the relay already ends in the same
`Connection` (`relay-link.ts:772-776`).

**C. No relay.** Document and automate a tailnet, `ssh -R` to a VPS, or a tunnel.

- **Tailnet** (Tailscale or WireGuard): `serve --address <tailnet-ip> --token`
  plus `connect ws://…`.
  - It works today with zero code, gets through NAT and needs no open port.
  - It needs a third-party agent and account on both machines.
  - The token is one shared bearer secret, with no per-client revoke.
- **`ssh -R` to a VPS**: needs a machine the user runs.
- **ngrok / Cloudflare Tunnel**: the provider terminates TLS, so it sees plaintext.

Keep C as the documented fallback (a few lines in the `connect` help or README),
not as the answer.

### Trust model (option A)

| Who holds what | Can do |
|---|---|
| **Relay (compromised).** It holds no key, only the relay id, timing, sizes and IPs. | Drop, delay or DoS the link. It can replay a message 1, which builds nothing. It cannot impersonate the serve, because the laptop pins the computer key (IK), and it cannot impersonate the laptop (static-key authentication). Same as for the phone today. |
| **Stolen laptop key** (the laptop's device private key for this computer). | Full `device` power on that serve project: drive turns and answer permissions, so in practice code execution on the host. That is the same as a stolen phone or token, but a plain file is easier to lift than the phone's Keychain item. Mitigations: the macOS Keychain (else a `0600` file), one key per computer (as the phone does), and `devices revoke`, which closes live sockets at once. **Gap:** revoke needs the host's terminal, which is exactly what the owner lacks in this scenario (owner Q4). |
| **Serve host (compromised).** It already owns the agent, the code and its own model key. | It can send any RPC to the laptop. That is the same as today's `connect`: the laptop grants a `serve` only what it grants now (the two trust bits at `connect.ts:296-305`), and laptop-side effects stay user-initiated. A host that is *not* the user's should be treated as a pod (§7), but that is out of scope here. |
| **Replay / downgrade.** | Noise IK: message 1 replay is inert. Version bytes in the handshake give a hint only (`device-accept.ts` `violationAudit`). `PROTOCOL_VERSION` is checked inside the channel. |

**Should a paired laptop get MORE rights than a phone?** No.

- A `device` already has every session right, including permission answers. File
  effects on the laptop are initiated by the laptop user and never granted by the serve.
- The only thing withheld from a device is the list of other projects on the
  computer, and that follows from a per-project pairing (owner decision,
  `connection.ts:703-708`).
- A "laptop class" would put a privilege on a claim rather than on the key (§7:
  a privilege is a property of the socket). If more projects are wanted, pair them.

### Failure modes

- **Relay down.** The dial rejects with a `ChannelError`, and `RemoteClient`'s
  `channelFactory` redials. The turn keeps running on the serve. The serve's link
  backs off (`relay-link-policy.ts`). A direct address, if one answers, wins the race.
- **Reconnect mid-turn.** A fresh handshake runs and the session resumes
  (pinned: `secure-channel.test.ts:143`). A re-sent permission answer is
  idempotent (`settled-answers.ts`). Pending asks are re-raised on re-attach. A
  revoked key gets `stopped` and does not redial in a storm (`secure-channel.test.ts:159`).
- **Phone and laptop on one session.** This already works for phone + `connect`:
  - both attach;
  - each ask carries `askedOn` (`hosted-session.ts:308-312`);
  - the first answer settles it;
  - push skips a device attached to the session (`connection.ts:1092-1095`).

  Nothing new is needed.
- **Version skew.** There are three layers, each refused cleanly:
  - the pairing payload `v` (`protocol/src/pairing.ts:35`);
  - `E2E_CHANNEL_VERSION` in the handshake;
  - `PROTOCOL_VERSION` at `initialize`.

  The laptop never speaks the relay's own protocol: `/d/<id>/e2e` is a raw splice.
- **Latency and throughput.** One extra hop. Streaming deltas are small frames.
  Large frames are chunked into Noise messages (pinned with a frame over 64 KiB).
  A leg past the backpressure ceiling is closed, and the client resyncs (F18).
  Attachments travel the same way the phone's photos already do. Laptop redials
  count against the relay's 30 dials per minute per IP.
- **Key rotation.**
  - Laptop key: re-pair, then revoke the old entry.
  - Computer identity reset (`devices reset`): every pin breaks (F11), so every
    device, laptop included, must re-pair. That is the honest outcome.
  - Relay secret or id change: the stored relay address goes stale. The daemon
    announces its addresses on every connect (sibling discovery), so the laptop's
    computer store must refresh them as the phone's does. Required in the plan.

### Recommendation

**GO for A**, with C documented now as the zero-code fallback. B is rejected.

- **Size:** M, down from the TODO's L: no daemon, relay or protocol change.
- **Blast:** load-bearing, because it creates a new on-disk credential that grants
  code execution on the host, and it touches the `connect` entry. Opus execution
  plus a fresh-context security review.
- **The ONE load-bearing assumption:** *a laptop that dials `<relay>/d/<id>/e2e`
  with a paired key lands in the same `acceptDevice` → `Connection` as a phone, and
  `connectTui` needs nothing but a `() => Promise<DuplexChannel>`, which
  `secureChannelFactory` already returns.* Proven by:
  - `relay-link.ts:772-776`;
  - `device-accept.ts:234`;
  - `connect.ts:238`, `:290-292`;
  - `secure-channel.ts:44-57`;
  - the green run above, a real `RemoteClient` over Noise in Bun.

  If it were false, B would be back on the table. It is not.

**Owner questions** (each with the recommended answer):

1. **Shape:** option A, device-mode `connect`, transport only, with no daemon or
   protocol change? **Rec: yes.** C is documented as the fallback and B is dropped.
2. **Rights:** does a paired laptop get exactly a phone's `device` rights, paired
   per project, with no "laptop" class? **Rec: yes.**
3. **Where the laptop key lives:** **Rec:** the macOS Keychain when available,
   else a `0600` file under `<configDir>`. One key per computer, never in argv or
   the environment.
4. **Revoke without host access:** should a paired device be able to *revoke*
   devices (itself or another) over RPC, but never *add* one? **Rec: yes, as a
   separate small follow-up.** Any device can already run shell on the host, so a
   revoke-only RPC adds no attack power and closes the stolen-laptop gap.
5. **Pairing approval:** does it stay a `y` on the host's terminal with the SAS
   compare? Or may an already-paired phone approve the laptop? **Rec: host terminal
   only in v1.** A device that approves devices lets a stolen phone enroll
   persistence that survives its own revoke.
6. **CLI:** **Rec:** pair with `tentacle connect --pair '<tentacle://pair?…>'`
   once, then use `tentacle connect <computer-name>` (direct first, relay last).
   Token `connect ws(s)://…` stays unchanged.

## Owner answers (2026-11-26, one at a time)

1. **Shape:** option A — `connect` device mode (pair like a phone; direct address first, relay last; no daemon/relay/protocol change, one session path).
2. **Rights:** the same as a paired phone, per project.
3. **Key:** macOS Keychain, else a 0600 file; one key per computer.
4. **Remote revoke:** yes, as a FOLLOW-UP task — a paired device may revoke others, never add.
5. **Pairing approval:** on the serve host's terminal only.
6. **Command:** `tentacle connect --pair '<payload>'` once, then `tentacle connect <name>`.

*— claude-opus-5-5 (orchestrator, recording the owner's answers), 2026-11-26*
