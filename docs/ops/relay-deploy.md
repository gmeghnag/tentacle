# Relay deploy runbook — `relay.tentacle.so`

The **mobile relay** (`apps/relay`, design `docs/feat/mobile-relay.md`) is a
stateless, end-to-end-encrypted splicer: it carries Noise ciphertext between a
phone and a `serve` daemon and authorises nothing. It holds no session and no
state (its one secret, the optional APNs key, is a systemd credential — §6), so it
has nothing to back up, migrate or reconcile — a restart costs every daemon one
jittered re-registration (`F3`).

**Deploy is the OWNER's step** (slice **D** in the design doc's slice table). An
executor writes and reviews these artefacts; no executor touches the server,
DNS, Caddy or the systemd on the box. Every command below is run by the owner (or
explicitly authorised by them), and each can be checked before the next.

- Host: the site's box `142.132.169.22` (decision 9)
- Public name: `relay.tentacle.so`, TLS terminated by Caddy
- Bind: `127.0.0.1:4100` (loopback only — the relay never listens publicly)
- Files here: `apps/relay/deploy/{build.ts,relay.service,Caddyfile.relay}` and
  `apps/relay/deploy/relay.service.d/apns.conf` (APNs push only, §6)

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

If it fails: `journalctl -u relay.service -b --no-pager` first, then step 9.

## 4. Caddy and TLS

DNS first — an `A` record `relay.tentacle.so → 142.132.169.22` (a later move of
the box is a DNS change, decision 9). Confirm it has propagated before Caddy
asks for a certificate, or ACME fails and Caddy backs off:

```sh
dig +short relay.tentacle.so        # → 142.132.169.22
```

Then the site block. Caddy obtains and renews the certificate itself; there is no
key to install here (unlike the APNs `.p8`, §6).

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
not only the new name. **Caddy runs in a podman container on this host** (host
network, `/etc/caddy` bind-mounted), so there is no `caddy` binary and no caddy
systemd unit: every Caddy command below goes through the container.

```sh
podman exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
podman exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
journalctl -u podman -n 30 --no-pager      # or: podman logs --since 5m caddy
```

Verify TLS and the health route from OUTSIDE the host (any machine):

```sh
curl -sSI https://relay.tentacle.so/healthz    # 200, HSTS, no `Server:` header
```

The site block also 404s every path that is not one of the relay's four routes
(`/healthz`, `/v1/daemon`, `/v1/accept`, `/d/<22-char id>/e2e`), so a path probe
never reaches the process — check it from outside too:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://relay.tentacle.so/        # 404
curl -sS -o /dev/null -w '%{http_code}\n' https://relay.tentacle.so/.env    # 404
```

`--trust-proxy` is what makes the relay's per-IP limits per CLIENT: the site
block replaces `X-Forwarded-For` with `{remote_host}`, and the relay reads that
header **only from a loopback peer** and takes the right-most untrusted hop
(`apps/relay/src/client-ip.ts`). Removing either half brings back the single
shared bucket — the unit flag and `header_up` are a pair.

`stream_close_delay 5m` in the site block is load-bearing: without it, every
`caddy reload` closes every live relay socket at once, i.e. every phone session on
the relay. Do not remove it to "tidy" the block.

What it buys is a **5-minute grace, not immunity**. The relay pings its legs
(`sendPings: true` in `apps/relay/src/server.ts`), so a live phone session and
every daemon control socket never go idle — Caddy force-closes them 5 minutes
after the reload. Treat a reload as a **staggered drop spread over those 5
minutes**: phones resync on their next dial (F1/F2) and daemons re-register with
jitter (F3), so it is a blip, but it is not a no-op. Schedule it off a long turn,
exactly like a `systemctl restart`.

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
`ready <id>` — a daemon registered · `dial-open <id>` — a phone dialled a known id
· `accept <id>` — the daemon took the stream, so the splice is live · `dial-held
<id>` — the daemon was not registered yet and the phone is being held (5 s) ·
`dial-refused <reason> <id>` — a per-client limit or a full slot; the phone leg is
then closed `4429`, and a phone whose id is unknown at the hold's expiry is
closed `4404` (step 9's table) · `pending-refused` — a control/accept socket past
the per-client pre-auth cap, closed `4429` · `log-suppressed <kind> <n>` — a
refusal flood: the n lines past 20-per-10 s-of-that-kind were dropped, and this is
their count.

Every line carries an 8-character **id** prefix only — a stream token is not
logged at all, no IP address is ever logged, and a full token, a payload or a
secret in the journal is a bug, not a log level. Verify it after a session:

```sh
journalctl -u relay.service --since "15 min ago" | grep -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'
# must print nothing
```

If the phone cannot reach it, the app's diagnosis names the relay as a path; a
`4404` in the journal means the daemon was not registered (step 3's status, then
`tentacle devices`), and a `version` error means binary and daemon disagree
on `RELAY_PROTOCOL_VERSION` (rebuild both from the same commit).

## 6. APNs push (the `.p8` secret)

Push is **optional and off by default**: with no key the relay logs one
`push off: no --apns-key-file (ready announces no features)` line at start and
serves exactly as before, and every daemon sees no `"push"` in `ready.features`
(docs/feat/mobile-push.md F4). Reachability must never depend on Apple's key, so
this step can be skipped, deferred or reverted without touching anything else:
the base `relay.service` contains no push wiring at all, and everything below is
one drop-in installed together with the key (§6.1).

The relay is stateless but **no longer secretless**: this one file is the only
secret on the host (decision 18 — it never enters the repo, a flag's value, or
the journal).

### 6.1 Install the key

The `.p8` comes from the Apple Developer console (Keys → an APNs Auth Key), and
it downloads exactly once. Its **Key ID** (10 characters) and your **Team ID**
are not secrets — they travel in the JWT header Apple already sees — but keep
them out of the repo too.

```sh
# build machine → host
scp AuthKey_ABC123DEFG.p8 root@142.132.169.22:/root/apns-key.p8
```

```sh
# as root on 142.132.169.22
install -d -o root -g root -m 0755 /etc/tentacle-relay
install -o root -g root -m 0400 /root/apns-key.p8 /etc/tentacle-relay/apns-key.p8
shred -u /root/apns-key.p8                     # no second copy
cat > /etc/tentacle-relay/apns.conf <<'EOF'
TENTACLE_RELAY_APNS_KEY_ID=ABC123DEFG
TENTACLE_RELAY_APNS_TEAM_ID=TEAM123456
EOF
chown root:relay /etc/tentacle-relay/apns.conf
chmod 0640 /etc/tentacle-relay/apns.conf
```

**Mode `0400`, owner `root`** is the point: `relay.service` runs as `relay`, so
the relay user has no readable copy of the key at all. systemd reads the file
(root), copies it into a read-only per-unit directory, and the binary is given
that copy's path.

The wiring is a **drop-in**, installed in this same step —
`apps/relay/deploy/relay.service.d/apns.conf`, which carries
`LoadCredential=apns-key:/etc/tentacle-relay/apns-key.p8` plus the four flags
(`--apns-key-file ${CREDENTIALS_DIRECTORY}/apns-key`, `--apns-key-id` and
`--apns-team-id` from `EnvironmentFile=-/etc/tentacle-relay/apns.conf`, and
`--apns-topic so.tentacle.app`). A drop-in has to restate the whole command
line, so its `ExecStart=` is the base unit's — `--trust-proxy` included (§4: the
per-client limits depend on it) — plus exactly those four flags:

```sh
install -d -o root -g root -m 0755 /etc/systemd/system/relay.service.d
install -o root -g root -m 0644 relay.service.d/apns.conf \
    /etc/systemd/system/relay.service.d/apns.conf
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/relay.service   # no output = clean
systemctl show relay.service -p ExecStart                   # --trust-proxy still there
systemctl restart relay.service
```

**Why a drop-in and not the unit** (review round 1): `LoadCredential=` with an
absolute path makes the unit *unable to start* when the key is absent — systemd
fails the start (243/CREDENTIALS) rather than skipping the credential — and an
unset `${VAR}` expands to an EMPTY ARGUMENT, which the relay used to refuse. In
the base unit the first would be a `Restart=always` crash loop, i.e. every phone
off the relay because Apple's key was not installed yet — the opposite of what §6
promises. So `relay.service` carries no push wiring at all and always starts with
push off; this drop-in is installed only alongside the key, and removing it (with
the two files above it) is the whole rollback. The relay is now lenient about a
blank `--apns-*` value, so the second failure mode is survivable too — but the
first is not ours to soften, which is why the wiring does not belong in the unit.

The bundle id is the one flag with a literal value, because it is public (it is
in the app's own `Info.plist`) and must never be daemon-supplied.
The same four values are available as `TENTACLE_RELAY_APNS_*` environment
variables, which is what the `EnvironmentFile` uses for the two IDs.

`apps/relay/test/deploy.test.ts` pins all of it: the base unit parses with every
variable expanded to empty and carries no `--apns-*`/`LoadCredential`/
`EnvironmentFile` at all, the drop-in's credential path is absolute, the
**`0400` mode** is in this runbook, the four flags are ones `main.ts` parses, and
the drop-in's command line is the base unit's plus exactly those four flags (a
partial set makes `readApnsKeySource` refuse and push stays off).

### 6.2 Install the unit and restart

```sh
# as root on 142.132.169.22 — the file is apps/relay/deploy/relay.service
install -o root -g root -m 0644 relay.service /etc/systemd/system/relay.service
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/relay.service   # no output = clean
systemctl restart relay.service
journalctl -u relay.service -n 5 --no-pager
```

Expect `push on: topic so.tentacle.app key ABC123DEFG` — the key id and topic,
**never the key**. Anything else is diagnosed below.

Confirm the daemon side too: on a laptop with a paired phone,
`tentacle serve --relay wss://relay.tentacle.so` then ask the phone's Settings
for the Notifications row — `on` means the daemon saw `"push"` in
`ready.features` and its registrations will be delivered. `relay-no-push` means
the relay started without a usable key: `journalctl -u relay.service | grep
"push off"` names what is missing, and the `--apns-*` flags are always the
suspect.

### 6.3 Rotate the key

Apple lets a team hold **two** APNs auth keys at once, so rotation needs no
downtime and no reinstall of the app:

1. In the console, create a NEW key and note its Key ID. Do **not** revoke the old
   one yet.
2. Install it exactly as 6.1 (`0400`, then edit `apns.conf`'s
   `TENTACLE_RELAY_APNS_KEY_ID`), and `systemctl restart relay.service`.
3. Confirm `push on: … key <NEWID>` and one real push arriving (6.4).
4. Only now revoke the old key in the console.

A key that is revoked while still in the unit fails every request with a `403`
that Apple answers `InvalidProviderToken`; the relay maps that to `rejected` and
the daemon audits `push-not-sent`, so the symptom is **silence plus audit lines**,
never a crash. Rolling back is step 1 in reverse: put the old key file back and
point `apns.conf` at its ID.

**Reverting push entirely** — the case review round 1 found broken, because it
must never cost the phones the relay:

```sh
# as root on 142.132.169.22
rm -f /etc/systemd/system/relay.service.d/apns.conf \
      /etc/tentacle-relay/apns-key.p8 /etc/tentacle-relay/apns.conf
rmdir /etc/systemd/system/relay.service.d 2>/dev/null || true
systemctl daemon-reload
systemctl restart relay.service
journalctl -u relay.service -n 5 --no-pager     # expect the `push off:` line
```

The drop-in goes in the SAME `rm` as the key on purpose: with the drop-in left
behind, `LoadCredential=` names a file that no longer exists and systemd refuses
to start the unit (243/CREDENTIALS) — a crash loop, not a rollback. **That is the
only outcome of a key-less drop-in**, and it is not softened by the blank-value
leniency: that covers a missing `/etc/tentacle-relay/apns.conf` (the two IDs,
which `parseRelayArgs` treats as "not set"), never a missing `.p8` — a
`LoadCredential=` whose file is absent fails the start before the binary is even
exec'd. So there is no "key gone but drop-in present is fine" case: remove both,
or you get a crash loop.

### 6.4 Smoke test a real push

The end-to-end proof needs an owner-approved dev build on a real iPhone (D2a: the
Push Notifications capability and the profile). With a phone paired and `serve`
connected to `wss://relay.tentacle.so`, start a turn that asks for permission
(`rm -rf build` is enough) and **walk away**: the banner must arrive after the
grace (`push.graceSeconds`, default 30 s, `serve --push-grace` to override).
Answer at the desk instead and the phone stays silent. The journal shows the
`push` frame's outcome (`sent`) and an 8-character token PREFIX — a full token,
a payload or the key in the journal is a bug.

**No Apple account and no device** is the simulator path, which proves the
entitlements and the plugin wiring rather than APNs: `bun run e2e:mobile`'s
`push-placeholder` flow pairs, grants notifications and hands
`xcrun simctl push` a payload captured from the daemon's own sealing chain, then
asserts the banner and the tap. It cannot deliver to Apple (a simulator issues no
APNs token), and it does not pretend to.

## 7. Upgrade

```sh
# build machine
bun apps/relay/deploy/build.ts
scp dist/tentacle-relay root@142.132.169.22:/opt/tentacle-relay/tentacle-relay.new

# host — keep the current binary as `.previous` first (step 8 rolls back to it)
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

## 8. Rollback

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

(Keep a copy as `tentacle-relay.previous` before the first `mv` in step 7.)

Push alone is reverted without touching the binary or the unit: §6.3's
"Reverting push entirely" (the drop-in and the key go in ONE `rm`).

To take the public name down entirely, remove the `import` line from
`/etc/caddy/Caddyfile`, run `podman exec caddy caddy validate --config
/etc/caddy/Caddyfile --adapter caddyfile`, then `podman exec caddy caddy reload
--config /etc/caddy/Caddyfile --adapter caddyfile`. Do this AFTER stopping the
unit, never before — the reload drops live streams within the 5-minute grace
(§4), and a name pointing at nothing is a worse error message than a stopped
unit.

## 9. Diagnose

```sh
systemctl status relay.service --no-pager     # state, restart count, last lines
journalctl -u relay.service -n 100 --no-pager # the relay's own lines
journalctl -u relay.service --since "10 min ago" --no-pager
curl -sS https://relay.tentacle.so/healthz    # through Caddy (TLS + route)
curl -sS http://127.0.0.1:4100/healthz        # the unit alone (bypasses Caddy)
ss -lntp | grep 4100                          # loopback only, as it must be
curl -sS http://127.0.0.1:4101/__status       # counters + 24 h per-minute history
```

`/__status` is a second listener, always on loopback: aggregate numbers only,
readable by any local process, reset on restart. From a laptop:
`ssh -L 4101:127.0.0.1:4101 <host>`, then the same `curl`. **Never proxy it**
(no Caddy directive names 4101). `--status-port <port|off>`
(`TENTACLE_RELAY_STATUS_PORT`) moves or disables it; if the port is busy the
relay logs `status-off EADDRINUSE` and runs without it. Frames over Bun's size
limit are closed before the relay sees them, so `refusedOversize` omits them.

| Symptom | Cause | Fix |
|---|---|---|
| `curl` to the name: connection refused / timeout | DNS not propagated, or Caddy not reloaded | `dig +short`, `podman exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, `podman logs caddy` |
| Certificate error for the name | ACME failed while DNS was wrong | fix DNS, `podman exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`, check `podman logs caddy` again |
| A phone is refused `4429` while the relay is idle | its public address already holds the per-CLIENT limit (16 sockets / 30 dials per min / 32 ids) — a carrier NAT or campus network puts many phones behind one address | read the `dial-refused` / `pending-refused` lines; raise `--max-streams-per-ip` / `--max-dials-per-minute` / `--max-ids-per-ip` in the unit — and in the push drop-in's restated `ExecStart=` if it is installed (§6.1, §10) |
| The journal shows `log-suppressed <kind> <n>` | a refusal flood: the n lines past the 20-per-10 s-per-kind bound were not written | expected under attack; the count is the summary. The first 20 of every kind are always there |
| Every client looks like `127.0.0.1` again | `--trust-proxy` missing from the unit, or `header_up X-Forwarded-For` missing from the site block | both are a pair (§4); `systemctl show relay.service -p ExecStart` |
| `curl` to loopback: refused | the unit is not running | `systemctl status`, step 3 |
| Unit `failed`, "start-limit-hit" | crash loop; the bound is doing its job | read the journal, fix the cause, `systemctl reset-failed relay.service` |
| Phone says unreachable, journal shows `4404` | daemon not registered (not running, or its control socket was replaced) | `tentacle devices`, restart `serve` |
| Journal shows a `version` error | binary/daemon `RELAY_PROTOCOL_VERSION` skew | rebuild both from the same commit (step 7) |
| Unit fails to start, `243/CREDENTIALS` | the push drop-in is installed but `/etc/tentacle-relay/apns-key.p8` is missing | put the key back, or remove the drop-in with it (§6.3) |
| `push off:` at start, phone Settings says `relay-no-push` | no key, or a partial `--apns-*` set | the line names what is missing; §6.1 |
| Streams drop on a Caddy reload | expected: `stream_close_delay` only delays the cut by 5 min | none — the phones resync (F1/F2); see §4 |
| Memory near `MemoryMax` | a flood, or many concurrent streams | the per-IP/per-id limits in `relay.service`; check `journalctl` for the refused lines |

## 10. Known limitations (state these, do not discover them later)

- **Per-IP limits are per CLIENT now, and that has a NAT consequence.**
  `--trust-proxy` plus the site block's `header_up X-Forwarded-For {remote_host}`
  make `apps/relay/src/client-ip.ts` the source of the limiter key: the header is
  read ONLY from a loopback peer and the right-most untrusted hop is taken, so an
  outside client cannot spoof it. An IPv6 client is collapsed to its `/64`
  (`limiterKeyOf`) — one phone's IPv6 prefix is one bucket, not 2^64 of them. The
  defaults therefore apply **per public address**: 16 concurrent phone sockets,
  30 dials/min, 10 registrations/min, 32 registered ids. Two residual facts:
  - A **carrier CGNAT or campus NAT** puts many unrelated phones behind ONE
    address, and they share that bucket. A phone refused `4429` redials, then
    falls back to its direct paths; the journal shows `dial-refused`, and every
    limit is still a flag (`--max-streams-per-ip`, `--max-dials-per-minute`,
    `--max-ids-per-ip`, …) so it can be raised without a rebuild.
  - Any process **on this host** (including a host-network container) can dial
    `127.0.0.1:4100` and forge the header. That bypasses the per-IP limits for
    local processes only, which can already exhaust loopback — accepted, and the
    reason the flag is off unless the unit asks for it.
  The per-id (64 streams) and global (10 000 ids) limits are unaffected either
  way. The old fleet sizes (6000 dials/min, 2000 sockets, 600 hellos/min) are
  GONE from `ExecStart` on purpose: with real keys they would hand every client
  the fleet's budget, i.e. no limit at all.
- **A refusal flood is summarised, not silently dropped.** Each kind of log line
  is capped at 20 per 10 s (`apps/relay/src/log-limit.ts`); the rest are counted
  and reported as one `log-suppressed <kind> <n>` line the next time the window
  ends. journald's own rate limit is why: it drops lines without choosing between
  them, `ready` ones included. The first 20 lines of every kind in every window
  always pass, so the start of an incident is always in the journal.
- **`MemoryMax=512M` is still the backstop, but it is no longer the only bound.**
  `maxPayloadLength` (96 KiB) makes Bun refuse an oversized frame before it
  allocates it, and pre-auth sockets are capped per client (`pendingPerIp`, 128)
  and closed at 10 s (`RELAY_PREAUTH_MS`). A flood now costs refused lines, not
  the relay's memory.
- **A Caddy reload drops live streams within 5 minutes.** `stream_close_delay 5m`
  in the site block delays the forced close of every WebSocket when Caddy's config
  is unloaded; it does not cancel it. Because the relay pings every leg, neither a
  phone session nor a daemon control socket goes idle, so nothing ends on its own
  first. A reload is therefore a staggered drop over the grace window — F1/F2
  resync the phones that drop and F3's jitter re-registers the daemons, but a long
  relayed turn will not survive it. Schedule reloads like restarts (§7).
- **The relay is no longer secretless.** It holds exactly one secret: the APNs
  auth key (`.p8`), as a systemd credential with the file `0400` root-owned, so
  the `relay` user cannot read it directly (`docs/feat/mobile-push.md` P10, §6
  above). It is never a file next to the binary, never a flag's VALUE, never in
  the journal, and never in the repo. Everything else about the host is
  unchanged: no database, no session, no state.
- **A relay without a key silently carries no push, by design.** No `push` in
  `ready.features` means every daemon skips the frame, so nothing is lost and
  nothing is retried: the ask stays pending on the daemon and the phone shows it
  on open (F4). The app's Settings says `relay-no-push` rather than claiming
  notifications work.
- **The publish path is untested end to end until this runs.** Everything in
  `apps/relay` is covered by `bun test` against a real socket on
  `127.0.0.1:0`; what only a deploy proves is the public cert (ATS), a relayed
  session surviving a Caddy reload for its 5-minute grace (§4), and an idle stream
  surviving 30 min of NAT/proxy timeouts (the relay pings every 25 s against a
  60 s idle timeout).

## Deploy log

- **2026-11-15 02:05 — first deploy (orchestrator, owner request).** Host 142.132.169.22 (Rocky Linux 9.8, x86_64). Binary sha256 `0d40597dafcf9f39c1c53cefc843b91c525dc19b57e67948ecea4bdf1e453799` at `/opt/tentacle-relay/tentacle-relay`; `relay.service` enabled (active, `relay listening on ws://127.0.0.1:4100`, push off). **Caddy runs in a podman container** (`caddy:2.8.4`, host network, `/etc/caddy` bind-mounted): validate/reload with `podman exec caddy caddy validate|reload --config /etc/caddy/Caddyfile --adapter caddyfile`, not `systemctl reload caddy`. `import /etc/caddy/relay.tentacle.so.caddy` appended to `/etc/caddy/Caddyfile` (backup `/root/Caddyfile.bak-20261115-010149`); certificate obtained; `https://relay.tentacle.so/healthz` → 200 `{"ok":true,"v":1}`; tentacle.so and gestionale.farci.to still 200.
- **2026-11-15 10:45 — relay-hardening deployed (orchestrator, owner OK).** Binary sha256 `68e366f76073a61342f2876e8d1fe3f905ff35703ed05eba572479cbd224c9af` (main 7226ca7b); unit with `--trust-proxy` and no fleet-size `--max-*` flags; new `Caddyfile.relay` (path allowlist, HSTS). Checks: local healthz ok; external `/healthz` 200 + `strict-transport-security`, no `Server` header; `/` and `/.env` 404; `/v1/daemon` 426; tentacle.so and gestionale.farci.to 200. Rollback artefacts: `/opt/tentacle-relay/tentacle-relay.previous`, `/root/relay.service.previous`, `/root/relay.tentacle.so.caddy.previous`.
- **2026-11-15 14:20 — APNs push on (D2, orchestrator, owner OK).** Binary sha256 `e452d6db29c67011653908c20ff6b99b8ad663fbb196dcdf00271eb8bd694cb2` (main d75cfe0e), smoke-tested on `127.0.0.1:4199` before install. Key installed per §6.1 (`/etc/tentacle-relay/apns-key.p8` 0400 root, `apns.conf` 0640 root:relay, key id in the journal only); `relay.service` (comment-only change) + drop-in `relay.service.d/apns.conf`; `ExecStart` shows `--trust-proxy` + the four `--apns-*` flags. Journal: `relay push on: topic so.tentacle.app key …`; `https://relay.tentacle.so/healthz` 200. §6.4 real-push smoke test pending a push-enabled device build. Rollback artefacts: `/opt/tentacle-relay/tentacle-relay.previous` (68e366f7…), `/root/relay.service.previous`; reverting push is §6.3.

- 2026-11-27 ~07:55 (owner «deploya anche relay-status»): main dc05e5a3 relay binary (`/__status` on 127.0.0.1:4101), previous kept as `/opt/tentacle-relay/tentacle-relay.prev-20261127`; restart OK, `/healthz` 200, both of the owner's serves re-registered within seconds (`registeredDaemons: 2`).
