# Relay

The relay lets your phone (the tentacle app) and your laptop reach a
`tentacle serve` that has **no open port and no public address**: a machine
behind NAT, at home, in the office.

## How it works

```
phone or laptop ──TLS──► relay.tentacle.so ◄──TLS── tentacle serve (dials out)
       └────────────── Noise, end to end ───────────────┘
```

- `serve` **dials out** to the relay and registers. Nothing listens on your
  network.
- Your device dials the relay too, and the relay joins the two sockets.
- **Two layers of encryption.** TLS on each hop to the relay, and inside it a
  Noise channel (`IK_25519_ChaChaPoly_SHA256`) from your device to your `serve`.
  The relay holds no key: it sees only ciphertext and cannot read or change a
  byte.
- **Direct first.** A device tries the `serve`'s direct addresses first and uses
  the relay only when none answers.
- `serve` knows each device by its own key, per project, and checks it before
  anything runs.

## Pair a device

Pairing is per project: run `tentacle pair` in the folder of a running `serve`.

**Phone:** scan the QR code `tentacle pair` shows (or paste its text in the app),
compare the 6-digit code on both screens and confirm on the computer.

**Laptop:**

```sh
tentacle pair                                         # on the serve's host
tentacle connect --pair '<tentacle://pair?…>'         # once, on the laptop: answer y on the host
tentacle connect <name>                               # from then on, from anywhere
```

The laptop's key is kept in the macOS Keychain (else a `0600` file).

Manage devices on the host:

```sh
tentacle devices                          # paired devices, by project
tentacle devices revoke <name|id-prefix>   # cut one off (--project, --all-projects)
tentacle devices reset [--yes]             # forget every device: they must pair again
```

On the laptop, `tentacle connect --forget <name>` drops a pairing.

## Configure

| Key | Default | Meaning |
| --- | --- | --- |
| `relay.enabled` | `true` | Whether `serve` dials the relay at all (`serve --no-relay` for one run). |
| `relay.url` | `wss://relay.tentacle.so` | Which relay `serve` dials (`serve --relay <url>` for one run). |
| `push.enabled` | `true` | Whether `serve` pushes notifications to its paired phones. |
| `push.graceSeconds` | `30` | How long an unanswered approval waits before the phone is pushed. |

A `serve` with no paired device never dials the relay.

## Run your own relay

The relay is open source (`apps/relay`): a small stateless Bun service that
splices ciphertext and keeps no session. Deploy it behind TLS and point
`relay.url` at it. Runbook: [`docs/ops/relay-deploy.md`](../ops/relay-deploy.md).
Design: [`docs/feat/mobile-relay.md`](../feat/mobile-relay.md),
[`docs/feat/connect-via-relay.md`](../feat/connect-via-relay.md).
