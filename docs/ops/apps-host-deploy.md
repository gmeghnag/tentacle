# Apps host deploy runbook (`apps.tentacle.so`)

**Deploy is the owner's step, never an executor's.** Nothing here was applied by
the task that wrote it (`docs/feat/session-apps-host.md`). The box is
`142.132.169.22`, which also serves `tentacle.so`, the relay and
`gestionale.farci.to`.

What runs: `tentacle-apps-host` (`apps/apps-host`) on `127.0.0.1:4200`, behind
the Caddy container, with its own user, unit and limits.

## 0. Preconditions

All of these are owner items; none is optional:

1. The DNS host of `tentacle.so` and an **API token** for it, scoped as narrowly
   as the provider allows (the wildcard certificate is issued by DNS-01 only).
2. `A` records `apps.tentacle.so` and `*.apps.tentacle.so` → `142.132.169.22`
   (`dig +short apps.tentacle.so`, `dig +short x.apps.tentacle.so`).
3. A mailbox that is read: the `--abuse-email` of the unit.
4. A terms page and a privacy page on `tentacle.so`: the `--terms-url` of the
   unit. The privacy text says reports keep the sender's address for up to 30
   days and visits are not logged.
5. Port 4200 free on the host: `ss -ltn | grep 4200` prints nothing.

Edit `--abuse-email` and `--terms-url` in `apps/apps-host/deploy/apps-host.service`
to the real values before installing it.

## 1. Build

On a development machine, from the repo root:

```sh
bun install --frozen-lockfile --filter '!@tentacle/mobile'
bun apps/apps-host/deploy/build.ts        # → dist/tentacle-apps-host (linux-x64)
shasum -a 256 dist/tentacle-apps-host
scp dist/tentacle-apps-host apps/apps-host/deploy/apps-host.service \
    apps/apps-host/deploy/Caddyfile.apps root@142.132.169.22:/root/apps-host/
```

## 2. Install on the host

As root, in `/root/apps-host`:

```sh
useradd --system --no-create-home --shell /sbin/nologin tentacle-apps
install -d -o root -g root -m 0755 /opt/tentacle-apps-host
install -o root -g root -m 0755 tentacle-apps-host /opt/tentacle-apps-host/tentacle-apps-host
install -d -o tentacle-apps -g tentacle-apps -m 0700 /var/lib/tentacle-apps
install -d -o root -g root -m 0755 /etc/tentacle-apps
install -o root -g root -m 0644 /dev/null /etc/tentacle-apps/takedowns
restorecon -Rv /opt/tentacle-apps-host      # Rocky: SELinux contexts
```

Both operator files must stay **world-readable** (`0644`): the service reads them
as `tentacle-apps`. An unreadable `kill-switch` counts as `all`.

## 3. The systemd unit

```sh
install -o root -g root -m 0644 apps-host.service /etc/systemd/system/apps-host.service
systemd-analyze verify /etc/systemd/system/apps-host.service
systemctl daemon-reload
systemctl enable --now apps-host
journalctl -u apps-host -n 20 --no-pager    # "apps-host start http://127.0.0.1:4200 …"
curl -sS -H 'Host: apps.tentacle.so' http://127.0.0.1:4200/healthz    # {"ok":true,"v":1}
```

## 4. Caddy with a DNS module

> **DONE on the tentacle.so box, 2026-11-26 (owner OK):** Caddy 2.8.4 → **2.11.9** built with
> `github.com/caddy-dns/hetzner/v2` (Hetzner Cloud DNS API; requires Caddy ≥ 2.11.2) as image
> `localhost/caddy-hetzner:2.11.9` from a binary cross-compiled with `xcaddy` (GOARCH=amd64); token from
> the new Hetzner Console in `/root/caddy.env` (mode 600) → container env `HETZNER_API_TOKEN`; the
> `*.apps.tentacle.so` wildcard certificate is issued (it needed `propagation_delay 90s`). Rollback:
> the stopped container `caddy-2.8.4-old` + `/root/Caddyfile.bak-2611`. Steps 1–4 below are kept as
> the generic procedure; for this box only steps 5+ (the apps-host process) remain.

The running `caddy:2.8.4` image has **no DNS provider module**, so it must be
replaced by one built with it. This touches every site on the box: do it in a
quiet window, and keep the old image for rollback.

1. Build the image (`<provider>` is the module name, e.g. `hetzner`,
   `cloudflare`; check it supports Caddy 2.8.4):

   ```sh
   cat > Containerfile <<'EOF'
   FROM docker.io/library/caddy:2.8.4-builder AS build
   RUN xcaddy build v2.8.4 --with github.com/caddy-dns/<provider>
   FROM docker.io/library/caddy:2.8.4
   COPY --from=build /usr/bin/caddy /usr/bin/caddy
   EOF
   podman build -t localhost/caddy-dns:2.8.4 .
   ```

2. Install the site block, with `<provider>` replaced, and import it:

   ```sh
   cp /etc/caddy/Caddyfile /root/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
   install -o root -g root -m 0644 Caddyfile.apps /etc/caddy/apps.tentacle.so.caddy
   # add to /etc/caddy/Caddyfile:  import /etc/caddy/apps.tentacle.so.caddy
   ```

3. Validate the WHOLE Caddyfile with the new image before touching the running
   container:

   ```sh
   podman run --rm -e TENTACLE_APPS_DNS_TOKEN=x -v /etc/caddy:/etc/caddy:ro,z \
     localhost/caddy-dns:2.8.4 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

4. Swap the container: record how the current one was created
   (`podman inspect caddy`), then recreate it with the SAME mounts, network and
   volumes (its certificate storage included), the new image, and
   `TENTACLE_APPS_DNS_TOKEN` from a root-only environment file (never on the
   command line). Keep `docker.io/library/caddy:2.8.4` on the host.

5. `podman logs --since 5m caddy` until the wildcard certificate is obtained;
   check `https://tentacle.so`, the relay's `/healthz` and
   `gestionale.farci.to` still answer.

Fallback when the DNS host has no API: delegate
`_acme-challenge.apps.tentacle.so` by `CNAME` to an acme-dns instance and use
`github.com/caddy-dns/acmedns` as the module.

## 5. Smoke test

From a machine outside the host:

```sh
curl -sSI https://apps.tentacle.so/healthz        # 200, HSTS, no Server, no Set-Cookie
curl -sS  https://apps.tentacle.so/healthz        # {"ok":true,"v":1}
curl -sS  https://apps.tentacle.so/robots.txt     # Disallow: /
```

A signed publish with a throwaway key. Save as
`.tentacle/tmp/apps-smoke/publish.ts` and run it from the repo root with
`bun .tentacle/tmp/apps-smoke/publish.ts`:

```ts
import {
  APPS_HEADERS,
  appsSigningPayload,
  encodeBase64Url,
} from "../../../packages/protocol/src/index.ts";

const domain = process.env.DOMAIN ?? "apps.tentacle.so";
const base = process.env.BASE ?? `https://${domain}`;
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const { privateKey, publicKey } = pair as CryptoKeyPair;
const raw = (await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer;
const body = new TextEncoder().encode("<!doctype html><title>smoke</title><h1>smoke app</h1>");
const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
const date = String(Date.now());
const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
const payload = appsSigningPayload({
  method: "POST",
  domain,
  path: "/v1/apps",
  date,
  nonce,
  bodySha256Hex: Buffer.from(digest).toString("hex"),
});
const signature = await crypto.subtle.sign(
  "Ed25519",
  privateKey,
  new TextEncoder().encode(payload),
);
const response = await fetch(`${base}/v1/apps`, {
  method: "POST",
  headers: {
    host: domain,
    "content-type": "text/html; charset=utf-8",
    [APPS_HEADERS.key]: encodeBase64Url(new Uint8Array(raw)),
    [APPS_HEADERS.date]: date,
    [APPS_HEADERS.nonce]: nonce,
    [APPS_HEADERS.signature]: encodeBase64Url(new Uint8Array(signature)),
  },
  body,
});
console.log(response.status, await response.text());
```

Expect `201` and a `url`. The app goes offline 5 minutes later (nobody renews it).

**In Safari AND in Chrome** (CI cannot prove any of this):

1. Open the URL from a link on another site, or type it → the **warning**.
2. Continue → the **app**.
3. Reload → the app.
4. Open it again from another site → the warning, which forwards by itself to
   the app (already acknowledged in this browser). In a private window → the
   warning stays until Continue.
5. A `fetch()` from the app's console fails (CSP `connect-src 'none'`).
6. Report this page → the form → "Report received"; the line is in
   `/var/lib/tentacle-apps/reports/<day>.jsonl`.
7. Kill switch on and off, and one takedown line (§6), on the smoke app.

## 6. Kill switch and takedowns

As root on the host. Both take effect without a restart: views within 1 s,
content removal within one sweep (10 s). Both survive a restart.

```sh
echo publish > /etc/tentacle-apps/kill-switch   # refuse new publishes and updates
echo all > /etc/tentacle-apps/kill-switch       # also serve only the maintenance page
rm /etc/tentacle-apps/kill-switch               # lift it
```

Anything else in the file (or an empty file) counts as `all`. Renewals keep
working under either mode, so live apps come back when it is lifted.

`/etc/tentacle-apps/takedowns` takes one entry per line, `app <id> <reason>` or
`key <publisher key> <reason>`; the reason is required, and the publisher is
shown it. `#` starts a comment line.

```takedowns
# 2026-11-30 phishing report
app abcdefghijklmnop phishing page imitating a bank login
key AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA repeated abuse
```

A malformed line is ignored and logged
(`operator-file takedowns line <n> invalid`): check `journalctl -u apps-host`
after every edit. An app's publisher key is `ownerKey` in
`/var/lib/tentacle-apps/apps/<id>.json`. Removing a `key` line unblocks that
key; an app already removed stays removed.

Reports are in `/var/lib/tentacle-apps/reports/`; nothing acts on them
automatically.

## 7. Limits

Add flags to the unit's `ExecStart` (each also has a `TENTACLE_APPS_…`
variable), then `systemctl daemon-reload && systemctl restart apps-host`.

| Flag | Default | What raising it costs |
|---|---|---|
| `--max-app-bytes` | 10 MiB | disk, memory per upload; raise `max_size` in Caddy too |
| `--max-live-apps-per-key` | 5 | one publisher's share |
| `--max-live-apps` | 2000 | disk, sweep time |
| `--max-store-bytes` | 2 GiB | disk on a shared box |
| `--min-free-disk-bytes` | 1 GiB | lowering it risks the other sites' disk |
| `--publishes-per-hour-per-key` | 30 | write churn |
| `--creates-per-hour-per-ip` | 20 | id and tombstone churn |
| `--new-keys-per-day-per-ip` | 10 | easier cap evasion with fresh keys |
| `--signed-per-minute-per-key` | 60 | CPU |
| `--api-per-minute-per-ip` | 120 | CPU before authentication |
| `--reports-per-hour-per-ip` | 5 | report noise |
| `--reports-per-day` | 1000 | disk, reading time |
| `--app-bytes-per-day` | 1 GiB | egress per app |
| `--max-tracked-ips` | 50000 | memory |
| `--max-tracked-keys` | 50000 | memory |
| `--max-tracked-nonces` | 200000 | memory (full = `503 busy`) |
| `--reserved-nonces-per-app` | 20 | memory a live app's renewals may add to a full nonce cache |
| `--max-in-flight-body-bytes` | 64 MiB | memory held by uploads (keep far below the unit's `MemoryMax`, and at least `--max-app-bytes`) |
| `--max-uploads-per-ip` | 2 | one address's share of that budget |
| `--upload-timeout-ms` | 120000 | how long a slow upload holds its share |
| `--lease-ms` | 300000 | how long an abandoned app stays up |
| `--renew-after-ms` | 60000 | renewal traffic (keep well below the lease) |
| `--skew-ms` | 300000 | the replay window |
| `--tombstone-ms` | 30 d | how long a URL can be revived |
| `--report-retention-ms` | 30 d | the privacy text must match |
| `--sweep-ms` | 10000 | how late removals happen |
| `--snapshot-ms` | 30000 | disk writes against restart accuracy |
| `--operator-stale-ms` | 1000 | how late the kill switch acts |

Disk: check `df -h /var/lib/tentacle-apps` against `--max-store-bytes` plus
tombstone records. Journal retention (30 days) is a host-wide journald setting
(`MaxRetentionSec`): the owner's call, it affects every service.

## 8. Upgrade

```sh
cp /opt/tentacle-apps-host/tentacle-apps-host /opt/tentacle-apps-host/tentacle-apps-host.prev
install -o root -g root -m 0755 tentacle-apps-host /opt/tentacle-apps-host/tentacle-apps-host
restorecon -Rv /opt/tentacle-apps-host
systemctl restart apps-host
curl -sS https://apps.tentacle.so/healthz
```

A restart keeps records, content and tombstones; apps live at the last snapshot
get one fresh lease. For a few seconds after it, a publisher whose clock runs
behind the host's is answered `409 replay` until its clock passes the start time.

## 9. Rollback

- Binary: install the `.prev` binary and restart.
- The whole service: `systemctl disable --now apps-host`, remove the `import`
  line from `/etc/caddy/Caddyfile`, validate and reload Caddy
  (`podman exec caddy caddy validate|reload --config /etc/caddy/Caddyfile
  --adapter caddyfile`), and, if the new image misbehaves, recreate the
  container from `docker.io/library/caddy:2.8.4`.

## 10. Moving to the separate domain

Configuration, DNS and a certificate; no code: change `--domain` in the unit and
the two names in the site block, add the records, restart. **Every existing app
URL changes**: the host computes each `url` from its configuration, so
publishers learn the new one from their next lease answer. Signatures made for
the old domain stop verifying (the domain is signed), so publishers must be
pointed at the new one.

## 11. Known limitations

- Interim domain: an app is same-site with `tentacle.so`. An abusive app can get
  `tentacle.so` listed by Safe Browsing, and its script can set a cookie for
  `.tentacle.so`. Both end with the separate domain.
- The CSP cannot stop an app from navigating away (`location = …`, a meta
  refresh). The warning, the lease and the takedown are the controls.
- A browser without Fetch Metadata only ever sees the warning.
- The warning drops a URL's `#fragment` on the way to the app.
- A restart forgets rate windows and each app's daily byte count.
- A few addresses uploading slowly can fill the upload budget: publishes and
  reports are answered `429`/`503` until those uploads end or time out.
  Renewals and deletes carry no body and are not affected.
- A `413` produced by Caddy or by the server's own body limit carries none of the
  host's headers.
- Blocking a key relies on the `takedowns` file: if it is unreadable when the
  service starts, key blocks are not applied until it is readable (apps already
  removed stay removed). Check the log for `operator-file takedowns unreadable`.

## 12. Turning publishing on

The publisher is part of tentacle (`docs/feat/session-apps-publish.md`); this
section is for the computer that runs `serve` or the TUI, after §5 passed.

**Config** (host config file only, never carried to a pod; both keys also work in
a profile):

```jsonc
"apps": { "enabled": true, "domain": "apps.tentacle.so" }
```

Restart `serve` after changing it. With `enabled` off (the default) the agent is
not offered `app_publish` / `app_unpublish`. Pod daemons (`run`, `attach`) are
never offered them.

**The key.** `<configDir>/apps/publisher.json` (Ed25519, JWK; file 0600, dir
0700), created at the first approved publish and shared by every session of this
computer. The host accepts renew, update and delete only from it. An unreadable
or damaged file is refused with its path and never replaced.

**Rotation.** Stop every live app (`/apps`, `s`), stop `serve`, remove the key
file, start again: the next approved publish makes a new key. Removing it with
apps live leaves them to lapse within one lease (5 min); they cannot be renewed
or deleted afterwards. A new key counts against the host's new-keys-per-address
daily budget (§7).

**Per-key cap.** The host allows 5 live apps per key, so 5 for the whole
computer, all sessions together (§7). A sixth publish answers «this computer
already has 5 live apps».

**Smoke, from a real session.**

1. Ask the agent to write a small HTML page, `present` it, then publish it. The
   ask must offer «Publish once» / «No» only, also with auto-accept on.
2. Open the URL (the first visit shows the warning page). `/apps` lists it `up`.
3. Present a changed page under the same artifact id and publish: same URL, a new
   ask.
4. `/apps`, `s`: the URL goes offline at once.
5. Publish again, then quit the TUI (a worker asks first) or close the session:
   offline.
6. On `serve`: publish, restart `serve` within 5 minutes, check `up`. On a
   laptop: sleep longer than 5 minutes, wake, check the same URL comes back with
   no new ask (the worker or a never-restarted `serve` still holds the page).
7. The phone: session info shows «Apps» with Copy and Stop.

**What the publisher cannot see.**

- Under the `all` kill switch (§6) renewals keep working, so `/apps` says `up`
  while visitors get the maintenance page. Under `publish` a new publish answers
  «publishing is paused by the operator».
- A `serve` restart longer than one lease cannot revive its apps: the page bytes
  are in memory only. The row says «publish again».
- A `DELETE` that never reaches the host (offline, process killed) leaves the
  page up until its lease lapses (≤ 5 min).
- Changing `apps.domain` with apps live: requests are signed for the domain, so
  the old host refuses them and the apps lapse. Change it with no live app (§10).

## Deploy log

*(nothing deployed yet)*
