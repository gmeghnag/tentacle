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
closed `4404` (step 8's table) · `pending-refused` — a control/accept socket past
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
`/etc/caddy/Caddyfile`, run `podman exec caddy caddy validate --config
/etc/caddy/Caddyfile --adapter caddyfile`, then `podman exec caddy caddy reload
--config /etc/caddy/Caddyfile --adapter caddyfile`. Do this AFTER stopping the
unit, never before — the reload drops live streams within the 5-minute grace
(§4), and a name pointing at nothing is a worse error message than a stopped
unit.

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
| `curl` to the name: connection refused / timeout | DNS not propagated, or Caddy not reloaded | `dig +short`, `podman exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, `podman logs caddy` |
| Certificate error for the name | ACME failed while DNS was wrong | fix DNS, `podman exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`, check `podman logs caddy` again |
| A phone is refused `4429` while the relay is idle | its public address already holds the per-CLIENT limit (16 sockets / 30 dials per min / 32 ids) — a carrier NAT or campus network puts many phones behind one address | read the `dial-refused` / `pending-refused` lines; raise `--max-streams-per-ip` / `--max-dials-per-minute` / `--max-ids-per-ip` in the unit (§9) |
| The journal shows `log-suppressed <kind> <n>` | a refusal flood: the n lines past the 20-per-10 s-per-kind bound were not written | expected under attack; the count is the summary. The first 20 of every kind are always there |
| Every client looks like `127.0.0.1` again | `--trust-proxy` missing from the unit, or `header_up X-Forwarded-For` missing from the site block | both are a pair (§4); `systemctl show relay.service -p ExecStart` |
| `curl` to loopback: refused | the unit is not running | `systemctl status`, step 3 |
| Unit `failed`, "start-limit-hit" | crash loop; the bound is doing its job | read the journal, fix the cause, `systemctl reset-failed relay.service` |
| Phone says unreachable, journal shows `4404` | daemon not registered (not running, or its control socket was replaced) | `tentacle devices`, restart `serve` |
| Journal shows a `version` error | binary/daemon `RELAY_PROTOCOL_VERSION` skew | rebuild both from the same commit (step 6) |
| Streams drop on a Caddy reload | expected: `stream_close_delay` only delays the cut by 5 min | none — the phones resync (F1/F2); see §4 |
| Memory near `MemoryMax` | a flood, or many concurrent streams | the per-IP/per-id limits in `relay.service`; check `journalctl` for the refused lines |

## 9. Known limitations (state these, do not discover them later)

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
  relayed turn will not survive it. Schedule reloads like restarts (§6).
- **The relay holds no secret today**, but task 16 (APNs, `docs/feat/mobile-push.md`
  P10) adds the `.p8` to this same host as a systemd credential — never a file
  next to the binary, never a flag in argv.
- **The publish path is untested end to end until this runs.** Everything in
  `apps/relay` is covered by `bun test` against a real socket on
  `127.0.0.1:0`; what only a deploy proves is the public cert (ATS), a relayed
  session surviving a Caddy reload for its 5-minute grace (§4), and an idle stream
  surviving 30 min of NAT/proxy timeouts (the relay pings every 25 s against a
  60 s idle timeout).

## Deploy log

- **2026-11-15 02:05 — first deploy (orchestrator, owner request).** Host 142.132.169.22 (Rocky Linux 9.8, x86_64). Binary sha256 `0d40597dafcf9f39c1c53cefc843b91c525dc19b57e67948ecea4bdf1e453799` at `/opt/tentacle-relay/tentacle-relay`; `relay.service` enabled (active, `relay listening on ws://127.0.0.1:4100`, push off). **Caddy runs in a podman container** (`caddy:2.8.4`, host network, `/etc/caddy` bind-mounted): validate/reload with `podman exec caddy caddy validate|reload --config /etc/caddy/Caddyfile --adapter caddyfile`, not `systemctl reload caddy`. `import /etc/caddy/relay.tentacle.so.caddy` appended to `/etc/caddy/Caddyfile` (backup `/root/Caddyfile.bak-20261115-010149`); certificate obtained; `https://relay.tentacle.so/healthz` → 200 `{"ok":true,"v":1}`; tentacle.so and gestionale.farci.to still 200.
- **2026-11-15 10:45 — relay-hardening deployed (orchestrator, owner OK).** Binary sha256 `68e366f76073a61342f2876e8d1fe3f905ff35703ed05eba572479cbd224c9af` (main 7226ca7b); unit with `--trust-proxy` and no fleet-size `--max-*` flags; new `Caddyfile.relay` (path allowlist, HSTS). Checks: local healthz ok; external `/healthz` 200 + `strict-transport-security`, no `Server` header; `/` and `/.env` 404; `/v1/daemon` 426; tentacle.so and gestionale.farci.to 200. Rollback artefacts: `/opt/tentacle-relay/tentacle-relay.previous`, `/root/relay.service.previous`, `/root/relay.tentacle.so.caddy.previous`.
