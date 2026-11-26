# eval/connect-via-relay — drive an unreachable `serve` from the laptop TUI through the relay

> **Status:** context · **review (verdict: GO for option A, pending owner answers)**
> **Branch:** none (an `eval`, committed to `main`, AGENTS §10)
> Type: eval · Size: M (if promoted, down from the TODO's L) · Blast: load-bearing (a new long-lived laptop credential that grants code execution on the `serve` host) · Suited: Opus plan + Opus execution of the key-store/pairing slice, mandatory fresh-context Opus security review
> **Changelog:** none (eval)

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

*(empty until promoted)*

## Execution

*(empty until promoted)*

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
