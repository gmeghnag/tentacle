# Relay deploy runbook — `relay.tentacle.so`

The **mobile relay** (`apps/relay`, design `docs/feat/mobile-relay.md`) is a
stateless, end-to-end-encrypted splicer: it carries Noise ciphertext between a
phone and a `serve` daemon and authorises nothing. It holds no session and no
secret, so it has nothing to back up, migrate or reconcile — a restart costs
every daemon one jittered re-registration (`F3`).

**Deploy is the OWNER's step** (slice **D** in the design doc's slice table). An
executor writes and reviews these artefacts; no executor touches the server,
DNS, Caddy or the systemd on the box. Every command below is run by the owner (or
explicitly authorised by them), and each can be checked before the next.

- Host: the site's box `142.132.169.22` (decision 9)
- Public name: `relay.tentacle.so`, TLS terminated by Caddy
- Bind: `127.0.0.1:4100` (loopback only — the relay never listens publicly)
- Files here: `apps/relay/deploy/{build.ts,relay.service,Caddyfile.relay}`

---

## 0. Preconditions

| # | Check | Why |
|---|---|---|
| 1 | `bun --version` ≥ 1.4.3 on the BUILD machine (not the host) | `engines.bun`; the compiled-binary worker path needs it |
| 2 | Root/sudo on `142.132.169.22` | systemd unit, `/opt`, Caddy |
| 3 | Caddy already serving the site's other names | this runbook adds one site block, it does not install Caddy |
| 4 | The branch carrying this runbook is merged, and `bun run check` is green | the unit and the Caddy block are guarded by `apps/relay/test/deploy.test.ts` |

The relay needs **no port opening**: the only listener is loopback, reached by
Caddy. If the host's firewall already admits 443, nothing to do.

## 1. Build the binary

On the build machine, from the repo root (the binary is Linux x64 — cross-compiled,
so the host needs neither Bun nor `node_modules`):

```sh
bun install
bun apps/relay/deploy/build.ts
```

→ `dist/tentacle-relay` (~90 MB; it embeds the Bun runtime). `build.ts` defaults
to `bun-linux-x64` on purpose: a host-triple default would hand the owner a
macOS executable named for a server. A flag-less `TARGET` mistake is refused:

```sh
TARGET=linux-x64 bun apps/relay/deploy/build.ts   # refused: TARGET must be a Bun triple
```

Prove the binary is the relay and it serves its health route, BEFORE it leaves
the build machine:

```sh
./dist/tentacle-relay --port 4100 &          # local smoke
curl -sS http://127.0.0.1:4100/healthz       # → {"ok":true,"v":1}
./dist/tentacle-relay --help                 # the flags, and the trust statement
kill %1
```

Optionally pin the artefact:

```sh
sha256sum dist/tentacle-relay | tee tentacle-relay.sha256
```

## 2. Install on the host

One-time: a system user with no home, no shell and no rights beyond running the
binary.

```sh
# as root on 142.132.169.22
useradd --system --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin --user-group relay
install -d -o root -g root -m 0755 /opt/tentacle-relay
```

Copy the binary from the build machine (from the build machine):

```sh
scp dist/tentacle-relay root@142.132.169.22:/opt/tentacle-relay/tentacle-relay.new
```

Then on the host — install it as an **atomic replace**, so a running relay keeps
its inode and a half-copied file is never executable by the unit:

```sh
# as root on 142.132.169.22
cd /opt/tentacle-relay
chown root:root tentacle-relay.new
chmod 0755 tentacle-relay.new
mv -f tentacle-relay.new tentacle-relay     # rename(2): atomic within the dir
./tentacle-relay --help >/dev/null && echo "binary runs"
```

Verify the checksum matches step 1 if one was taken:

```sh
sha256sum /opt/tentacle-relay/tentacle-relay
```

## 3. The systemd unit

```sh
# as root on 142.132.169.22 — the file is apps/relay/deploy/relay.service
install -o root -g root -m 0644 relay.service /etc/systemd/system/relay.service
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/relay.service   # no output = clean
```

What the unit guarantees (and `deploy.test.ts` pins): `Restart=always` with a
`5`-in-`30 s` start-limit so a crash loop parks visibly instead of spinning; the
full sandbox (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
`CapabilityBoundingSet=` empty — the relay writes nothing and needs no
capability); `MemoryMax=512M` as the last resort behind the per-IP/per-id limits
in `relay-core.ts`; logs to the journal only.

```sh
systemctl enable --now relay.service
systemctl status relay.service --no-pager
journalctl -u relay.service -n 20 --no-pager
```

Expect `relay listening on ws://127.0.0.1:4100 (relay protocol v1)`.

```sh
curl -sS http://127.0.0.1:4100/healthz     # → {"ok":true,"v":1}
```

If it fails: `journalctl -u relay.service -b --no-pager` first, then step 8.

## 4. Caddy and TLS

DNS first — an `A` record `relay.tentacle.so → 142.132.169.22` (a later move of
the box is a DNS change, decision 9). Confirm it has propagated before Caddy
asks for a certificate, or ACME fails and Caddy backs off:

```sh
dig +short relay.tentacle.so        # → 142.132.169.22
```

Then the site block. Caddy obtains and renews the certificate itself; there is no
key to install here (unlike the APNs `.p8` a later task adds).

```sh
# as root on 142.132.169.22 — the file is apps/relay/deploy/Caddyfile.relay
install -o root -g root -m 0644 Caddyfile.relay /etc/caddy/relay.tentacle.so.caddy
```

Add one line to the host's main `/etc/caddy/Caddyfile`, inside any global block
that is already there (or at the top level):

```
import /etc/caddy/relay.tentacle.so.caddy
```

Validate before reloading — a syntax error in a reload takes the whole site down,
not only the new name:

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -n 30 --no-pager     # the certificate for relay.tentacle.so
```

Verify TLS and the health route from OUTSIDE the host (any machine):

```sh
curl -sS -i https://relay.tentacle.so/healthz    # 200 {"ok":true,"v":1}, a valid cert
```

`stream_close_delay 5m` in the site block is load-bearing: without it, every
`caddy reload` closes every live relay socket, i.e. every phone session on the
relay. Do not remove it to "tidy" the block.

## 5. Smoke test (relay path end to end)

The relay alone answering `/healthz` does not prove a stream splices. On a laptop
with a paired phone:

```sh
# laptop, in the project you serve
tentacle devices                            # ≥ 1 paired device
tentacle serve --relay wss://relay.tentacle.so
```

```sh
# laptop, second terminal: the daemon registered?
journalctl -u relay.service -f              # expect `ready <8-char id prefix>`
```

Then open the app on a phone **on cellular, with Wi-Fi off** (so no LAN address
can succeed), pick the computer and drive one message. Expect a session, a reply,
and `journalctl -u relay.service` showing the stream's `dial-open` / `accept` lines
— never a payload (the relay sees ciphertext only).

Log lines you should see, and what they mean (`apps/relay/src/server.ts`):
`ready <id>` — a daemon registered · `dial-open <id> <stream>` — a phone dialled a
known id · `accept <stream> <id>` — the daemon took the stream, so the splice is
live · `dial-held <id>` — the daemon was not registered yet and the phone is being
held (5 s) · `dial-refused <reason> <id>` — a limit or a full slot; the phone leg
is then closed `4429`, and a phone whose id is unknown at the hold's expiry is
closed `4404` (step 8's table). Every line carries an 8-character id or token
PREFIX only: a full token, a payload or a secret in the journal is a bug, not a
log level.

If the phone cannot reach it, the app's diagnosis names the relay as a path; a
`4404` in the journal means the daemon was not registered (step 3's status, then
`tentacle devices`), and a `version` error means binary and daemon disagree
on `RELAY_PROTOCOL_VERSION` (rebuild both from the same commit).

## 6. Upgrade

```sh
# build machine
bun apps/relay/deploy/build.ts
scp dist/tentacle-relay root@142.132.169.22:/opt/tentacle-relay/tentacle-relay.new

# host — keep the current binary as `.previous` first (step 7 rolls back to it)
cd /opt/tentacle-relay
cp -p tentacle-relay tentacle-relay.previous
chown root:root tentacle-relay.new && chmod 0755 tentacle-relay.new
mv -f tentacle-relay.new tentacle-relay     # rename(2): atomic within the dir
systemctl restart relay.service
curl -sS https://relay.tentacle.so/healthz
```

A restart drops every control socket; daemons re-register with jitter (F3), and
live streams are independent sockets that die by their own pings — a running
turn on a daemon continues and the phone re-attaches (F1/F2). Schedule it
accordingly; it is a blip, not an outage. **No reload of Caddy is needed**, and it
is not the way to upgrade the relay.

## 7. Rollback

Stop the unit — the fail-safe is that the relay is **optional** for every client:

```sh
systemctl disable --now relay.service
```

- Daemons: the control socket drops, they back off (1 s → 60 s, jittered) and
  retry forever; the app falls back to the direct addresses after 750 ms, so a
  paired phone on the LAN, Tailscale or an own domain is unaffected.
- Phones with no direct path: the dial fails and the diagnosis says unreachable.
- Nothing to restore: the relay keeps no state, and no session history lives here.

To go back one binary version:

```sh
systemctl stop relay.service
install -o root -g root -m 0755 /opt/tentacle-relay/tentacle-relay.previous \
        /opt/tentacle-relay/tentacle-relay
systemctl start relay.service
```

(Keep a copy as `tentacle-relay.previous` before the first `mv` in step 6.)

To take the public name down entirely, remove the `import` line from
`/etc/caddy/Caddyfile`, `caddy validate`, then `systemctl reload caddy`. Do this
AFTER stopping the unit, never before — a reload with a live relay behind it is
harmless, but a name pointing at nothing is a worse error message.

## 8. Diagnose

```sh
systemctl status relay.service --no-pager     # state, restart count, last lines
journalctl -u relay.service -n 100 --no-pager # the relay's own lines
journalctl -u relay.service --since "10 min ago" --no-pager
curl -sS https://relay.tentacle.so/healthz    # through Caddy (TLS + route)
curl -sS http://127.0.0.1:4100/healthz        # the unit alone (bypasses Caddy)
ss -lntp | grep 4100                          # loopback only, as it must be
```

| Symptom | Cause | Fix |
|---|---|---|
| `curl` to the name: connection refused / timeout | DNS not propagated, or Caddy not reloaded | `dig +short`, `caddy validate`, `journalctl -u caddy` |
| Certificate error for the name | ACME failed while DNS was wrong | fix DNS, `systemctl reload caddy`, check `journalctl -u caddy` again |
| `curl` to loopback: refused | the unit is not running | `systemctl status`, step 3 |
| Unit `failed`, "start-limit-hit" | crash loop; the bound is doing its job | read the journal, fix the cause, `systemctl reset-failed relay.service` |
| Phone says unreachable, journal shows `4404` | daemon not registered (not running, or its control socket was replaced) | `tentacle devices`, restart `serve` |
| Journal shows a `version` error | binary/daemon `RELAY_PROTOCOL_VERSION` skew | rebuild both from the same commit (step 6) |
| Streams drop on every Caddy reload | `stream_close_delay` missing | restore it from `Caddyfile.relay` |
| Memory near `MemoryMax` | a flood, or many concurrent streams | the per-IP/per-id limits in `relay.service`; check `journalctl` for the refused lines |

## 9. Known limitations (state these, do not discover them later)

- **Per-IP limits key on the direct peer, which behind Caddy is always
  `127.0.0.1`.** `apps/relay/src/server.ts` uses Bun's `requestIP`, and the proxy
  hop is the peer, so `--max-dials-per-minute` / `--max-streams-per-ip` /
  `--max-hellos-per-minute` are ONE shared bucket in this deployment rather than
  per-phone: the 16-concurrent-streams-per-IP default would cap the whole world at
  16 phones. Either raise those three flags in `ExecStart` to fleet-sized values,
  or (the better fix, a code change, not this runbook) have the relay read
  `X-Forwarded-For` behind a trusted-local flag. **The owner decides before the
  first real deploy**; the per-id (64 streams) and global (10 000 ids) limits are
  unaffected.
- **The relay holds no secret today**, but task 16 (APNs, `docs/feat/mobile-push.md`
  P10) adds the `.p8` to this same host as a systemd credential — never a file
  next to the binary, never a flag in argv.
- **The publish path is untested end to end until this runs.** Everything in
  `apps/relay` is covered by `bun test` against a real socket on
  `127.0.0.1:0`; what only a deploy proves is the public cert (ATS), a Caddy
  reload not cutting live streams, and an idle stream surviving 30 min of NAT/proxy
  timeouts (the relay pings every 25 s against a 60 s idle timeout).
