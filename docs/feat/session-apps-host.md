# feat/session-apps-host — the apps host: publish, lease and serve single-file session apps

> **Status:** implementation (APPROVED — owner delegated the details, see *Orchestrator decisions*)
> **Branch:** `feat/session-apps-host`
> **Type:** feat · **Size:** L (a new service: ~9 source files + deploy + runbook) · **Blast:** contained but PUBLIC (a new app and an additive, non-RPC protocol module; no §7 invariant, no RPC/persisted session format touched — but it is a public, unauthenticated hosting surface) · **Suited:** Sonnet executes; mandatory fresh-context Opus review (public surface, L)
> **Changelog:** `changelog.d/session-apps-host.added.md`

Umbrella: `docs/feat/session-apps.md` (P1 of 6). P2 `feat/session-apps-publish`
(the tools, the broker, the lease loop) consumes the contract this task defines.

## Context

*— claude-opus-5-5, 2026-11-26*

**Why.** The owner approved session apps (umbrella, owner answers
`docs/feat/session-apps.md:460-477`): the agent publishes a self-contained HTML
page, the user approves, a public URL `<id>.<apps-domain>` lives as long as the
session. The serving model is **upload + lease** (`session-apps.md:96-101`, :140-142):
the bytes go to a small host we run; visitors never reach the user's machine.
Nothing on our side can receive, keep or serve such a page today — this task
builds that host. P2 is useless without it (`session-apps.md:325-327`).

**Binding constraints (owner, 2026-11-26):**
- Domain is CONFIG; interim `apps.tentacle.so` (`session-apps.md:473`), later a
  separate registrable domain on the PSL (`:462`) — switching = config + DNS, no code.
- Runs on the current `tentacle.so` box, as **its own process and site block with
  its own limits** so moving it is a deploy, not a rewrite (`:477`, `:463`).
- Network OFF inside apps in v1 (`:464`); CSP enforced by the host (`:197-212`).
- Lifetime tied to the session, **no maximum** — the lease stays, a live session
  keeps its app up indefinitely (`:465`).
- First-visit warning «published by a tentacle user · Report» from day one (`:466`).
- No accounts: apps are owned by **the serve's key**; rate/size limits + kill
  switch (`:467`).
- v1 = ONE self-contained HTML file (`:469`).
- The host sets **no cookies** and never shares an origin with `tentacle.so` (`:473`).
- Deploy and DNS changes only with the owner (`:477`): this task ships code,
  tests, deploy artefacts and a runbook — it deploys nothing.

**Known interim risk (owner's call, `:473`), restated once:** under
`*.apps.tentacle.so` an app is *same-site* with `tentacle.so`; an abusive app can
get `tentacle.so` listed by Safe Browsing, and its script can set a cookie for
`.tentacle.so` (nothing on `tentacle.so`/the relay reads cookies — verified by
the relay routes, `apps/relay/src/server.ts:8-13`). Both end with the domain move.

**Repro** (2026-11-26, `HEAD 3ea66943`, run from the worktree; scripts in
`.tentacle/tmp/session-apps-host/`, pasted here because that folder is gitignored):

```
$ ls apps
browser-extension  mobile  relay
$ git grep -c -e "apps-host" -e "apps\.tentacle\.so" -- packages apps scripts
(no output: no apps host, no publish client)
```

Two capability probes the plan stands on (see *Load-bearing assumption*):

```ts
// ed.ts — does Bun's WebCrypto do Ed25519 raw-key import + sign + verify?
const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const msg = new TextEncoder().encode("hello");
const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, msg));
const pub = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
console.log("pub", raw.length, "sig", sig.length, "ok", await crypto.subtle.verify("Ed25519", pub, sig, msg),
  "tamper", await crypto.subtle.verify("Ed25519", pub, sig, new TextEncoder().encode("hellp")));
```
```
$ bun --version            → 1.4.3
$ bun .tentacle/tmp/session-apps-host/ed.ts
pub 32 sig 64 ok true tamper false
```

```ts
// serve-caps.ts — Bun.serve maxRequestBodySize, Host routing, statfs
import { statfsSync } from "node:fs";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024,
  async fetch(req) { const body = new Uint8Array(await req.arrayBuffer());
    return Response.json({ host: req.headers.get("host"), len: body.length }); } });
const base = `http://127.0.0.1:${server.port}/`;
const small = await fetch(base, { method: "POST", body: "x".repeat(100), headers: { host: "abc.apps.example" } });
console.log("small", small.status, await small.text());
const big = await fetch(base, { method: "POST", body: "x".repeat(5000) });
console.log("big", big.status, await big.text());
server.stop(true);
const s = statfsSync("/"); console.log("statfs free bytes", s.bavail * s.bsize > 0);
```
```
$ bun .tentacle/tmp/session-apps-host/serve-caps.ts
small 200 {"host":"abc.apps.example","len":100}
big 413
statfs free bytes true
```

## Implementation

*— claude-opus-5-5, 2026-11-26* · **APPROVED** (owner delegated the remaining details to the orchestrator, 2026-11-26)

### Load-bearing assumption

**The host can authenticate a publisher it has never seen — by a bare Ed25519
public key, with no account and no new dependency — and bound an upload before
it reads it.** Everything else (ownership, takedown by key, per-key caps, replay
refusal) is bookkeeping on top of "this request was signed by the holder of key K".

Proved (Repro above): Bun 1.4.3's WebCrypto imports a raw 32-byte Ed25519 public
key, verifies a 64-byte signature and rejects a tampered message (`ok true tamper
false`); `Bun.serve({ maxRequestBodySize })` answers **413 before the handler
reads the body** (`big 413`). Bun ≥ 1.4.3 is the repo floor (`package.json:8-10`).
So the host needs no `@noble/*` (those are a `packages/transport` dependency,
`packages/transport/package.json:14-16`, not available to an app without adding one).

A second, browser-side assumption — that a top-level navigation started by the
interstitial's own script carries `Sec-Fetch-Site: same-origin` and a link from
anywhere else does not — is standard Fetch Metadata behaviour but **cannot be
proved in CI** (no browser). It fails closed (a browser without Fetch Metadata
only ever sees the warning, never the app without it) and is an explicit owner
smoke step in the runbook (*Tests → unverified*).

### Preconditions

Verified in the source:

- **The relay is the pattern to copy.** A Bun process binding loopback because
  Caddy terminates TLS in front of it (`apps/relay/src/server.ts:46-49`); a thin
  `Bun.serve` whose every decision is in a pure, unit-tested core
  (`server.ts:1-6`, `apps/relay/src/relay-core.ts:45-53` for the limit table);
  flags + env parsed by a pure function whose invalid value is a refusal, never
  ignored (`apps/relay/src/main.ts:109-115`, :117-122); the entry point under
  `import.meta.main` (`main.ts:349-382`); a pure route function pinned without a
  socket (`server.ts:107-139`); tests on `port: 0` with an injected clock and a
  captured log (`apps/relay/test/server.test.ts:28-40`).
- **The real client address behind Caddy** is solved and tested:
  `clientIpOf({ peer, forwardedFor, trustProxy })` reads `X-Forwarded-For` only
  from a loopback peer, only opted in, right-most hop (`apps/relay/src/client-ip.ts:1-28`,
  :79); `limiterKeyOf` collapses IPv6 to /64 (`client-ip.ts:115`); the server
  applies both from `srv.requestIP` (`server.ts:371-382`). Caddy replaces the
  header with `{remote_host}` (`apps/relay/deploy/Caddyfile.relay:42`). These two
  modules import nothing but `node:net` (`client-ip.ts:29`) / nothing
  (`log-limit.ts`), so they can be **re-exported** by `@tentacle/relay` (its
  `exports` map is `apps/relay/package.json:7-10`) and reused, not copied.
- **A log-flood bound** exists: per-kind windows with an honest
  `log-suppressed` summary (`apps/relay/src/log-limit.ts:1-24`, `createLogLimiter` :64).
- **Deploy artefacts are inert and drift-guarded**: the unit's `ExecStart` must
  parse with `main.ts`'s own parser at the default address, the Caddy route regex
  must match the route function, the runbook must name the same binary
  (`apps/relay/test/deploy.test.ts:18-30`, :162-213, :328); the unit's sandbox
  (`apps/relay/deploy/relay.service:71-94`), memory bound (:105-106), no secret in
  argv (:1-11); the compile script defaults to `bun-linux-x64` (`apps/relay/deploy/build.ts:22-25`).
- **The box:** Caddy 2.8.4 runs **in a podman container** (host network, only
  `/etc/caddy` bind-mounted); validate/reload through `podman exec caddy …`
  (`docs/ops/relay-deploy.md:161-168`, deploy log :564). The stock image has **no
  DNS-provider module** (`session-apps.md:60-66`), and a wildcard certificate is
  DNS-01 only (`session-apps.md:181-186`).
- **Wire contracts live in `@tentacle/protocol`, not in a peer**: the relay's
  control wire is there with its OWN version, explicitly not `PROTOCOL_VERSION`
  (`packages/protocol/src/relay.ts:1-6`); base64url helpers exist
  (`packages/protocol/src/pairing.ts:60` encode, :91 decode); a box that does
  crypto keeps it out of the protocol package (`packages/transport/src/relay-id.ts:14-17`).
  Every exported `*Schema` lands in the generated `protocol.json`
  (`packages/protocol/src/json-schema.ts:9-10`), so new schemas need
  `bun run schema:export` on the branch (the merge step regenerates it anyway, AGENTS §10).
- **Workspace mechanics:** `workspaces: ["packages/*", "apps/*"]` (`package.json:7`);
  `typecheck` lists each app's `tsc -p` explicitly (`package.json:12`) — a new app
  must be added there or it is never type-checked; an app with a `version` is
  released in lockstep (`scripts/release.ts:91-97`), so the new package carries
  `0.7.1` like `apps/relay/package.json:3`; tests are discovered under `apps/*`
  and run with the env guard preloaded (`bunfig.toml:2`).
- **Network-off pages are what the model already writes** for `present`
  (`packages/core/src/artifact-csp.ts:51-53`), so the host's stricter header CSP
  does not change what P2 publishes.

### Design

#### Orchestrator decisions

The owner delegated the details; each is the recommended option, with the one
reason that decides it.

| # | Decision | Chosen | Why (the alternative, rejected) |
|---|---|---|---|
| D1 | Who serves the bytes | **The Bun process** (Caddy only proxies) | Caddy runs in podman with only `/etc/caddy` mounted (`relay-deploy.md:161`): `file_server` needs a new bind mount of the data dir on a container that also serves `tentacle.so` and a third party's app; and the security headers belong in tested code, not in a Caddyfile. A single HTML ≤ 10 MiB is trivially served by Bun. |
| D2 | Publisher authentication | **Ed25519-signed requests** (`Tentacle-Key/-Date/-Nonce/-Signature`), key = the serve's publish key (P2 decides where it is kept) | A bearer secret (the relay's shape) is replayable from any log/proxy that sees it and would need a server-side store of secret hashes; a signature binds method, path, domain and body hash, and the host stores only public keys. |
| D3 | Replay | **Refused** (`409 replay`): a `(key, nonce)` seen in the ±5 min window, or a `Date` before the process started | Returning the recorded result instead (idempotent replay) costs a response cache; a lost `create` response is already harmless — the orphan app is never renewed and dies with its 5-min lease. Every retry signs anew. |
| D4 | App ids | **Host-minted**, 16 chars of lowercase base32 = **80 bits**, from `crypto.getRandomValues` | Client-chosen ids allow vanity squatting (`paypal-login…`, `session-apps.md:217-219`). |
| D5 | First-visit warning without cookies | **Fetch Metadata + `localStorage`**: `GET /` serves the APP only to a same-origin top-level navigation (`Sec-Fetch-Site: same-origin`, `-Mode: navigate`, `-Dest: document`), else the host-owned WARNING page; its Continue (and, once acknowledged in this browser, an automatic `location.replace`) is exactly that same-origin navigation | A query flag (`?continue`) is shareable, so a phisher links past the warning; a POST-to-continue makes reload/back ask to resubmit; a cookie is forbidden. A link from any other site — another app, mail, a chat — is `cross-site`/`same-site`/`none` → the warning. No Fetch Metadata (old browser) → the warning forever, with a loop guard: fails closed. |
| D6 | Page policy | Header CSP **network off + `sandbox allow-scripts allow-modals allow-same-origin`** (full header list below) | Sandbox without `allow-downloads`/`allow-popups`/`allow-forms` blocks blob-built malware downloads, pop-ups and forms on top of `connect-src`/`form-action 'none'`; `allow-same-origin` keeps `localStorage` working (a page written for `present` that keeps a score must not crash). Without `allow-same-origin` cookies would also be impossible, but apps would throw on storage — rejected; the cookie residual ends with the domain move. |
| D7 | Lease | **TTL 5 min, renew every 60 s, no maximum lifetime** (owner Q4); on lapse the content is deleted and a **tombstone** (id, owner key) kept **30 days**, during which the owner may **revive the same URL** by re-uploading (`PUT`) | The umbrella's shape (`session-apps.md:96-101`, :155-161) minus the 7-day cap the owner removed. |
| D8 | What a restart keeps | Records + content on disk; leases in a **snapshot written every 30 s**; at start, an app whose lease was valid at the last snapshot gets **one fresh TTL** | Persisting every renewal is a write per app per minute for nothing; without the extension a 6-min host outage would delete every app although every publisher kept trying. |
| D9 | Operator controls (kill switch, takedown) | **Files in a read-only operator dir** (`/etc/tentacle-apps/kill-switch`, `/etc/tentacle-apps/takedowns`), re-read with ≤ 1 s staleness | An admin HTTP route would sit behind the same Caddy as the public; a unix socket needs a client. A file is root-writable, survives restarts, is auditable, and needs no new surface. |
| D10 | Shared contract | **`packages/protocol/src/apps-host.ts`**: headers, id shape, the signing payload, the response/error schemas; own `APPS_API_VERSION = 1`, **not** `PROTOCOL_VERSION` (not an RPC peer, like `relay.ts:1-6`); no crypto in it | P2's publisher and this host must agree byte for byte; `@tentacle/protocol` is the shared truth (AGENTS §7). |
| D11 | Reuse | `@tentacle/relay` gains two **export entries** (`./client-ip`, `./log-limit`); no relay code changes | Copying the XFF logic would fork a security-sensitive parser. |
| D12 | Required config | `--domain`, `--abuse-email`, `--terms-url` are **required**: the process refuses to start without them | Abuse contact and terms must be live before the first public URL (`session-apps.md:414-415`). |
| D13 | Reports | Stored + logged, **never acted on automatically**; retention 30 days | A report flood must not take down an innocent app; the operator decides. |
| D14 | Indexing | `robots.txt` = disallow all, `X-Robots-Tag: noindex, nofollow` on every response | User content in search results is phishing SEO. |
| D15 | Where things live | Port **4200** on loopback; data `/var/lib/tentacle-apps` (systemd `StateDirectory`); operator files `/etc/tentacle-apps` (`ConfigurationDirectory`, read-only to the service); user `tentacle-apps` | Mirrors the relay (4100, `relay.service:49`). |
| D16 | Runbook location | **`docs/ops/apps-host-deploy.md`** (the "deploy README") | The relay's runbook is `docs/ops/relay-deploy.md`; one place for the owner's ops docs; pinned by `deploy.test.ts` like the relay's. |

#### Shape

```
serve (P2) ──HTTPS, signed──► Caddy *.apps.tentacle.so + apps.tentacle.so (wildcard, DNS-01)
visitor   ──HTTPS GET /─────►   │ reverse_proxy, Host kept, X-Forwarded-For replaced, Set-Cookie stripped
                                ▼
                      tentacle-apps-host 127.0.0.1:4200   (Bun, its own unit, its own limits)
                        ├─ route by Host: <domain> = control API, <id>.<domain> = an app, else 404
                        ├─ pure core: leases, caps, rate limits, ownership, kill/takedown state
                        ├─ store: /var/lib/tentacle-apps (records, content, snapshot, reports)
                        └─ operator files: /etc/tentacle-apps/{kill-switch,takedowns} (read-only)
```

#### The contract (`packages/protocol/src/apps-host.ts`)

- `APPS_API_VERSION = 1`; `APP_ID_LENGTH = 16`; `isAppId(s)` = `/^[a-z2-7]{16}$/`.
- Headers: `Tentacle-Key` (b64url of the 32-byte Ed25519 public key, 43 chars),
  `Tentacle-Date` (Unix ms, decimal), `Tentacle-Nonce` (b64url of 16 random bytes,
  22 chars), `Tentacle-Signature` (b64url of 64 bytes, 86 chars).
- `appsSigningPayload({ method, domain, path, date, nonce, bodySha256Hex })` →
  the exact string `"tentacle-apps/1\n" + METHOD + "\n" + domain + "\n" + path +
  "\n" + date + "\n" + nonce + "\n" + bodySha256Hex` (UTF-8, signed as bytes).
  The **domain** is in it so a request signed for the interim domain cannot be
  replayed at the final one; **path** excludes the query (the API takes none).
  The caller hashes (no crypto here, `relay-id.ts:14-17`).
- Schemas (strip, not `.strict()`): `AppsLeaseResultSchema { id, url,
  leaseExpiresAt, leaseMs, renewAfterMs }` (create, update, renew) and
  `AppsErrorSchema { error: AppsErrorCode, message, retryAfterMs?, reason?,
  serverTime? }` with `AppsErrorCode` = `bad_request | bad_signature |
  clock_skew | replay | not_found | forbidden | blocked | taken_down | expired |
  deleted | too_large | unsupported_media | malformed | rate_limited |
  cap_reached | conflict | storage_full | killed | busy | internal`. `reason` is
  the operator's statement of reasons on `blocked`/`taken_down` (DSA,
  `session-apps.md:308-310`) — P2 shows it in the session.

#### Control API (Host = `<domain>`)

| Method + path | Auth | Body | Success |
|---|---|---|---|
| `POST /v1/apps` | signed | the HTML (`Content-Type: text/html[; charset=utf-8]`) | `201` lease result (new id) |
| `PUT /v1/apps/<id>` | signed, owner | the HTML | `200` lease result — replaces the content (a new version) **or revives** an `expired` tombstone, same URL |
| `POST /v1/apps/<id>/lease` | signed, owner | empty | `200` lease result; `410 expired` → re-upload with `PUT` |
| `DELETE /v1/apps/<id>` | signed, owner | empty | `204`; content deleted now, URL → `410` |
| `GET /healthz` | — | — | `{ ok: true, v: 1 }`, no counters (as `server.ts:362-366`) |
| `GET /` | — | — | host-owned info page: what this is, abuse e-mail, terms link |
| `GET /report?app=<id>` · `POST /v1/report` · `GET /report/thanks` | — | form: `app`, `reason` ∈ {phishing, malware, illegal, other}, `details` ≤ 2000, `contact` ≤ 200 | `303` → thanks |
| `GET /robots.txt` | — | — | `Disallow: /` |

Any other path → 404; a known path with another method → 405.

**Signed-request pipeline** (server, in this order — cheap checks before crypto,
crypto before any state): route → kill switch for create/update → per-IP API rate
→ header shapes (`bad_request`) → `|now − date| ≤ 300 s` else `401 clock_skew`
with `serverTime`; `date < startedAt` → `409 replay` → read body (Bun-capped) →
SHA-256 → Ed25519 verify (`401 bad_signature`) → nonce guard (`409 replay`;
cache full → `503 busy`, never evict an in-window nonce) → key blocked
(`403 blocked` + reason) → per-key rate → core.

**Content checks:** `Content-Type` must be `text/html` (else 415); body non-empty
and valid UTF-8 (`TextDecoder("utf-8", { fatal: true })`, else `400 malformed`);
≤ `maxAppBytes` (Bun's `maxRequestBodySize` = `maxAppBytes`, plus a handler
re-check → 413). Bytes are stored and served **verbatim** — never rewritten.

#### Visitor side (Host = `<id>.<domain>`)

Only `GET`/`HEAD /` (any query) and `GET /robots.txt`; other paths 404, other
methods 405. Decision table (pure, `visitorView` + `core.viewOf`), first match wins:

| Condition | Response |
|---|---|
| kill switch `all` | 503 host-owned "temporarily unavailable" |
| id not well-formed or unknown | 404 "no such app" |
| `taken_down` | 410 "removed by the operator" |
| `deleted` | 410 "unpublished" |
| `expired`, or `now > leaseExpiresAt` (before the sweep runs) | 503 "offline — the tentacle session that published it is not running" |
| over `appBytesPerDay` | 503 "over its daily limit" |
| not a same-origin top-level navigation (D5) | 200 **warning page** |
| otherwise | 200 **the app**, its bytes from the store |

**App response headers** (fixed; the page can only tighten them with a `<meta>`):
`Content-Type: text/html; charset=utf-8` ·
`Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-modals allow-same-origin` ·
`X-Content-Type-Options: nosniff` · `Referrer-Policy: no-referrer` (the app URL
never leaks through a clicked link) · `Cross-Origin-Opener-Policy: same-origin` ·
`Cross-Origin-Resource-Policy: same-origin` · `Permissions-Policy: camera=(),
microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(),
bluetooth=(), display-capture=(), publickey-credentials-get=()` ·
`X-Robots-Tag: noindex, nofollow` · `Cache-Control: no-store` (no stale copy
after a takedown) · `Vary: Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest`.
**No response, from any route, ever carries `Set-Cookie`** (and Caddy strips it).

**Host-owned pages** (warning, offline, removed, maintenance, info, report,
thanks) are fixed templates in `pages.ts`: no external resource, `Cache-Control:
no-store`, a CSP of `default-src 'none'` plus a `'sha256-…'` hash of their own
inline style/script (computed at load from the constant, so the header and the
body cannot drift); `form-action 'self'` only on the report form (control
origin). Interpolated values are the validated id, the configured abuse e-mail
and terms URL — all HTML-escaped. The warning says: *published by a tentacle
user, not by tentacle; tentacle does not review it; do not enter passwords or
personal data* · **Continue** · **Report this page** (`https://<domain>/report?app=<id>`).
Its inline script: if `localStorage["tentacle-apps-ack"] === "1"` and no
auto-forward happened in the last 3 s (`sessionStorage` timestamp — the loop
guard for a browser without Fetch Metadata) → `location.replace(location.href)`;
Continue sets the ack and navigates the same way. The ack lives on the app's
origin; the app could only set it after the user already passed the warning once.

#### Core state (pure, injected clock + random)

`AppRecord { v: 1, id, ownerKey, state: "live" | "expired" | "deleted" |
"taken_down", sha256, bytes, createdAt, updatedAt, tombstoneUntil?, reason? }`;
in memory only: `leaseExpiresAt` per live app, rate windows, nonce cache,
per-app daily byte counters, in-flight ids.

- **Create:** caps (below) → mint id (retry on collision with any known id,
  live or tombstoned, up to 3×; then `500 internal`) → a **reservation** (counts
  the id, the bytes, the per-key slot) → store writes → `commit` or, on any store
  error, `release` (state as before).
- **Update/revive (`PUT`):** owner only (`403 forbidden`); `deleted` → `410
  deleted`; `taken_down` → `403 taken_down` + reason; one in-flight write per id
  (`409 conflict`); revive re-checks the live caps.
- **Renew:** owner only; `live` → `leaseExpiresAt = now + leaseMs` — **no
  maximum, ever** (owner Q4); `expired` → `410 expired`; allowed under kill
  `all` (so apps return when it is lifted).
- **Delete:** owner only; content removed, `deleted` tombstone.
- **Sweep** (every `sweepMs`): lapsed leases → `expired` + content removed;
  tombstones past `tombstoneUntil` → record removed (the id becomes 404);
  report files older than 30 days removed; takedown entries applied; snapshot
  written every `snapshotMs`; owed `log-suppressed` lines flushed.

**Caps and limits** (`limits.ts`, one table, every one a `--flag` + env, as `main.ts:96-106`):

| Limit | Default |
|---|---|
| `maxAppBytes` | 10 MiB |
| `maxLiveAppsPerKey` | 5 |
| `maxLiveApps` (global) | 2 000 |
| `maxStoreBytes` (live content) | 2 GiB |
| `minFreeDiskBytes` (statfs on the data dir) | 1 GiB |
| `publishesPerHourPerKey` (create + update) | 30 |
| `createsPerHourPerIp` | 20 |
| `newKeysPerDayPerIp` (distinct keys creating from one address) | 10 |
| `signedPerMinutePerKey` | 60 |
| `apiPerMinutePerIp` (before any crypto) | 120 |
| `reportsPerHourPerIp` / `reportsPerDay` | 5 / 1 000 |
| `appBytesPerDay` (visitor egress per app, UTC day) | 1 GiB |
| `maxTracked` (IPs, keys, nonces — bounded maps) | 50 000 / 50 000 / 200 000 |
| `leaseMs` / `renewAfterMs` / `skewMs` | 5 min / 60 s / 5 min |
| `tombstoneMs` / report retention | 30 d / 30 d |
| `sweepMs` / `snapshotMs` / operator-file staleness | 10 s / 30 s / 1 s |

#### Store (`store.ts`, behind a `Store` interface so tests inject a memory/failing one)

```
<data>/apps/<id>.json               the record (tmp + fsync + rename)
<data>/apps/<id>-<sha256[0..16]>.html   the content (tmp + fsync + rename) — named by its hash
<data>/leases.json                  { v: 1, aliveAt, leases: { <id>: expiresAt } }
<data>/reports/<YYYY-MM-DD>.jsonl   one line per report (ip, app, reason, details, contact, at)
```
Write order on create/update: content file → record (names the new sha) →
unlink the previous content. A crash between steps leaves an **orphan** content
file that the start-up scan deletes (a file no record names). A record with an
unknown `v` is skipped and logged, never overwritten. Content is served with
`new Response(Bun.file(path))` (no full read into memory).

#### Operator files (`operator-files.ts`, pure parse)

- `kill-switch`: absent = off; content `publish` = refuse create/update; `all` =
  also serve only the maintenance page. Unreadable or any other content = `all`
  (**fail closed**) + one log line.
- `takedowns`: one entry per line, `app <id> <reason…>` or `key <b64url-key>
  <reason…>`; `#` comments and blanks ignored; a malformed line is logged (with
  its number) and ignored, the rest applies. Effect within one sweep: content
  removed, record `taken_down` with the reason; a key entry takes down all its
  apps and refuses every request it signs (`403 blocked` + reason). Removing a
  `key` line unblocks it; a removed app stays removed (republishing is a new
  approval in P2).

#### Logs

stdout → journal, through `createLogLimiter` (`log-limit.ts:64`). Lines: `start`,
`publish <id> key <8-char prefix> ip <addr> bytes <n>`, `update …`, `revive …`,
`delete <id>`, `expire <id>`, `takedown <id> <reason>`, `blocked-key <prefix>`,
`report <id> <reason> ip <addr>`, `refused <code> ip <addr>`, `kill <off|publish|all>`,
`store-error <op> <errno>`, `snapshot-failed <errno>`, `operator-file <name>
line <n> invalid`. Never: content, signatures, nonces, report free text.
Renewals and visitor requests are **not** logged (volume; visitor privacy).
The full key of an app is in its record (root-readable) for a takedown.

### Files

In dependency order (protocol → app → deploy → docs):

1. `packages/protocol/src/apps-host.ts` (new) — the contract above.
2. `packages/protocol/src/index.ts` — `export * from "./apps-host.ts";`.
3. `packages/protocol/schema/protocol.json` — regenerated (`bun run schema:export`), never hand-edited.
4. `apps/relay/package.json` — add `"./client-ip": "./src/client-ip.ts"`, `"./log-limit": "./src/log-limit.ts"` to `exports` (no code change).
5. `apps/apps-host/package.json` (new) — `@tentacle/apps-host`, `version` = the repo's current (`0.7.1`), deps `@tentacle/protocol`, `@tentacle/relay` (`workspace:*`).
6. `apps/apps-host/tsconfig.json` (new) — as `apps/relay/tsconfig.json:1-13`, paths for `@tentacle/protocol`, `@tentacle/relay/client-ip`, `@tentacle/relay/log-limit`.
7. `apps/apps-host/src/limits.ts` — `APPS_LIMITS` + the flag/env table.
8. `apps/apps-host/src/app-id.ts` — `mintAppId(random)`, `hostRoute(host, domain)` (`control | app(id) | unknown`; port stripped, lowercased; `evilapps.tentacle.so`, `a.b.<domain>` → unknown).
9. `apps/apps-host/src/signed-request.ts` — header parse, skew/start check, body hash, Ed25519 verify (WebCrypto), `NonceGuard`.
10. `apps/apps-host/src/operator-files.ts` — `parseKillSwitch`, `parseTakedowns`.
11. `apps/apps-host/src/host-core.ts` — the pure core (records, leases, reservations, caps, rate windows, views, sweep plan, snapshot in/out).
12. `apps/apps-host/src/pages.ts` — templates, `visitorView(headers)`, `appResponseHeaders()`, `pageHeaders(kind)`.
13. `apps/apps-host/src/store.ts` — `Store` interface + `createFsStore(dir, fs?)` (fs injectable for ENOSPC).
14. `apps/apps-host/src/server.ts` — `startAppsHost(options)`: thin `Bun.serve` (`maxRequestBodySize`), routing, the pipeline, applying core decisions to the store; exposes `sweep()`, `core`, `stop()` like `RunningRelay` (`server.ts:96-105`).
15. `apps/apps-host/src/main.ts` — `parseAppsHostArgs(argv, env)` (pure; required `--domain`/`--abuse-email`/`--terms-url`), `--help`, `import.meta.main` start + SIGINT/SIGTERM (final snapshot on stop).
16. `apps/apps-host/deploy/build.ts` — compile to `dist/tentacle-apps-host`, `bun-linux-x64` default (as `apps/relay/deploy/build.ts`).
17. `apps/apps-host/deploy/apps-host.service` — `User=tentacle-apps`, `ExecStart=/opt/tentacle-apps-host/tentacle-apps-host --host 127.0.0.1 --port 4200 --trust-proxy --domain apps.tentacle.so --abuse-email … --terms-url …`, `StateDirectory=tentacle-apps`, `ConfigurationDirectory=tentacle-apps` (+ `ReadOnlyPaths=/etc/tentacle-apps`), the relay's sandbox block (`relay.service:71-94`, minus nothing; JIT note kept), `MemoryMax=512M`, `Restart=always`, start limit in `[Unit]`.
18. `apps/apps-host/deploy/Caddyfile.apps` — the site block (below).
19. `apps/apps-host/test/` — the tests below + `test/support/memory-store.ts` (memory store with scripted failures).
20. `package.json` — `typecheck` += `&& tsc -p apps/apps-host --noEmit`.
21. `bun.lock` — from `bun install` (links the new workspace).
22. `docs/ops/apps-host-deploy.md` (new) — the owner's runbook (below).
23. `changelog.d/session-apps-host.added.md` (new) — one bullet:
    > - **Apps host for session apps.** A new service (`apps/apps-host`) keeps a single-file HTML app published by a tentacle `serve` and serves it at `<id>.<apps domain>`: network off, a first-visit warning with a Report link, size/rate/count caps, a lease that lasts as long as the session, a kill switch and takedowns. Not deployed yet; the publish tools come next.
24. `AGENTS.md` §6 — the repo-facts line: the apps list gains `apps/apps-host` (a plain Bun process, own `tsc -p apps/apps-host`) — a fact update, not a rule change.

**Caddy site block** (`Caddyfile.apps`; inert, applied by the owner):

```
*.apps.tentacle.so, apps.tentacle.so {
	tls {
		dns <provider> {env.TENTACLE_APPS_DNS_TOKEN}   # DNS-01: wildcard only issues this way
	}
	request_body {
		max_size 10MiB           # = maxAppBytes (MiB, not MB = 10^6); the process re-checks
	}
	header {
		Strict-Transport-Security "max-age=31536000"   # no includeSubDomains, no preload
		-Server
		-Set-Cookie
	}
	reverse_proxy 127.0.0.1:4200 {
		header_up X-Forwarded-For {remote_host}
		header_down -Set-Cookie
	}
	# no `log` directive: visitor access is not logged (privacy, umbrella §3.5 / §5)
}
```

**Runbook** (`docs/ops/apps-host-deploy.md`) — sections: 0 preconditions (P0
owner items: DNS host of `tentacle.so` and its API token; `*.apps` + `apps` A
records → `142.132.169.22`; abuse mailbox; terms + privacy pages on `tentacle.so`;
port 4200 free: `ss -ltn`) · 1 build (`bun apps/apps-host/deploy/build.ts`) ·
2 install (user, `/opt`, `/var/lib/tentacle-apps` 0700, `/etc/tentacle-apps`
root-owned 0755 with an empty `takedowns`) · 3 unit · 4 **Caddy with a DNS
module**: build `caddy:2.8.4` + the provider module with `xcaddy` into a new image
tag, `caddy validate` against the WHOLE current Caddyfile, swap the container
keeping the old image for rollback (this touches `tentacle.so`, the relay and
`gestionale.farci.to` — do it in a quiet window); fallback if the DNS host has
no API: delegate `_acme-challenge.apps.tentacle.so` by CNAME to an acme-dns
instance (`caddy-dns/acmedns`) · 5 smoke tests (`/healthz`; a signed publish
with a throwaway key from a laptop script; **in Safari and Chrome: link →
warning, Continue → app, reload → app, open from another site → warning**; kill
switch on/off; a takedown line) · 6 kill switch and takedown (exact commands,
the line format the parser accepts) · 7 limits (each flag, what it costs; disk
budget vs free space; journald retention — 30 days is a host-wide setting, the
owner's call) · 8 upgrade · 9 rollback (stop unit, remove the `import` line,
revert the Caddy image) · 10 moving to the separate domain (config + DNS +
certificate; every existing URL changes — tell P2's publishers by the
`url` field, which the host computes from config) · 11 known limitations ·
deploy log. "Deploy is the owner's step, never an executor's" stated at the top.

### Failure modes

1. **Forged publish** (no key, wrong key, tampered body/method/path/domain) →
   `401 bad_signature`, no state touched (verify precedes the core). A stolen
   private key publishes under that identity within the same caps; the owner
   blocks the key with one `takedowns` line; P2 rotates its key.
2. **Replay** of a captured request → same `(key, nonce)` in window: `409 replay`;
   outside ±5 min: `401 clock_skew`; signed before the process started (the
   nonce cache is memory-only and lost on restart): `409 replay`. A request for
   one domain replayed at another fails the signature (domain is signed). Nonce
   cache full → `503 busy` (fail closed; an in-window nonce is never evicted —
   eviction would reopen replay). Only verified requests enter the cache, so an
   unsigned flood cannot fill it; signed floods are bounded per key and per IP.
3. **Clock skew of the publisher** → `401 clock_skew` with `serverTime`; P2
   corrects its offset and re-signs (contract field, not a guess).
4. **A lease that stops renewing** (laptop asleep, serve down, network) → at
   `leaseExpiresAt` visitors get the 503 offline page immediately (the view
   checks the clock, it does not wait for the sweep); the next sweep deletes the
   content (`expired` tombstone, 30 d). The publisher's next renew gets `410
   expired` and re-uploads with `PUT` → same URL, live again. Past the tombstone
   → 404; a new publish gets a new id. A live session keeps renewing forever —
   no maximum (owner Q4; pinned by a test).
5. **Huge upload** → Caddy 10 MiB, Bun `maxRequestBodySize` (413 before the
   handler, Repro), handler re-check → `413 too_large`; nothing stored.
   **Malformed** → wrong type `415`, empty/invalid UTF-8 `400 malformed`, bad
   headers `400 bad_request`, unknown path `404`, wrong method `405`, a query on
   the API `400`. Bytes are never parsed or rewritten, so a hostile HTML cannot
   exploit the host's parser — only the visitor's browser, under the CSP.
6. **Id collision / guessing** → 80-bit random ids; a mint that hits any known
   id (live or tombstoned) retries (3×, then `500 internal` + log — pinned with
   a scripted random). Guessing 2^80 is not a threat; the wildcard certificate
   keeps ids out of CT logs; no `Referer` leaves an app; no access log; robots
   disallow. Ids are lowercase; `Host` is case-folded before routing.
7. **Abuse report flood** → per-IP 5/h, global 1 000/day (beyond: `503` page
   with the abuse e-mail), fields length-capped, `app` must be a known id (404),
   reports are **never** an automatic takedown (D13), retention 30 days. Report
   lines are rate-limited in the journal (`log-limit`).
8. **Kill switch** → `publish`: create/update `503 killed`, renew/delete/serve
   unaffected. `all`: every app URL → 503 maintenance, create/update refused,
   renew/delete still work (leases do not lapse because of our own switch).
   Garbled/unreadable file → `all` (fail closed). Survives a restart (a file).
   Lifting it is deleting the file; effective within 1 s.
9. **Takedown** → content gone within one sweep (≤ 10 s) and the URL is `410`
   at once (the view checks the takedown set); the owner's next renew/update gets
   `403 taken_down` + reason (statement of reasons). A takedown that races an
   in-flight `PUT` is re-checked at `commit`: the write is discarded.
10. **Disk full** → pre-checks: `maxStoreBytes` budget and `statfs` free <
    `minFreeDiskBytes` → `507 storage_full` before writing. A write that fails
    anyway (ENOSPC/EIO): tmp removed, reservation released, record unchanged —
    an update keeps serving the old version — `507`/`500` + `store-error` log.
    Snapshot write failure → logged, serving continues; on restart the older
    snapshot only errs toward one extra TTL of life. Reports on a full disk →
    `503`, the abuse e-mail shown.
11. **Restart of the host** → survives: records, live content, tombstones,
    operator files, reports, the snapshot (apps live at the last snapshot get
    one fresh TTL, D8 — a 10-min host outage does not delete every app). Lost,
    and why that is fine: the nonce cache (covered by "signed before start" →
    replay), rate windows (a fairness reset, re-checked per request), per-app
    daily byte counters (stated; a viral app gets a fresh day), in-flight
    writes (tmp files + orphans removed by the start-up scan). Unknown record
    version → skipped and left untouched.
12. **Concurrent writes to one app** → one in-flight write per id, the second
    gets `409 conflict` (Bun is single-threaded but a store write awaits).
13. **Domain switch** → only config + DNS + certificate: records hold no
    domain, URLs are computed; old signatures stop verifying (domain is signed),
    so P2 must re-sign against the new domain — intended.
14. **A visitor's browser without Fetch Metadata** → warning page only; the
    loop guard stops the auto-forward and the page says the browser cannot open
    it. Fails closed (never the app without the warning).
15. **Navigation residual** (CSP cannot stop `location = …` or a meta refresh)
    → stated, as in the umbrella (`session-apps.md:207-210`): the warning, the
    lease and the takedown are the controls.
16. **Caddy reload / host IP blocklisted** → a reload only drops in-flight
    HTTP; a blocklisting of the IP hits every site on the box — the interim
    risk the owner accepted; the runbook's move section is the exit.

### Tests

Iterate per file (`bun test apps/apps-host/test/<file>`); full gate before done.
All new code ⇒ every test is written first and shown **red** (the module or the
behaviour missing), then green; the listed **mutations** are run once each by
the executor and their red recorded in Execution (AGENTS §9 non-vacuity).
Fakes: injected clock (`now`), injected random, `memory-store.ts` (scripted
ENOSPC/EIO per operation), injected operator-file reader, real Ed25519 keys from
WebCrypto (cheap, no fake needed), `Bun.serve` on `port: 0` with a captured log
(relay pattern). No real infra; nothing under `/var` or `/etc`.

- `packages/protocol/test/apps-host.test.ts` — the signing payload is a pinned
  golden string; changing method, domain, path, date, nonce or body hash each
  changes it; `isAppId` accept/reject table; schemas strip unknown fields and
  reject a bad error code. *Mutation:* drop `domain` from the payload → red.
- `app-id.test.ts` — mint = 16 chars `[a-z2-7]` from the random; `hostRoute`
  table (apex, `<id>.<domain>`, `:443` suffix, upper case, `a.b.<domain>`,
  `evil<domain>`, `<domain>.evil`, empty).
- `signed-request.test.ts` — valid; each tampered field → `bad_signature`;
  another key → `bad_signature`; ±301 s → `clock_skew` + `serverTime`;
  date < start → `replay`; second use of a nonce → `replay`; full cache →
  `busy`, then accepted after the window passes; each malformed header →
  `bad_request`. *Mutation:* skip the nonce guard → red.
- `operator-files.test.ts` — kill-switch: absent/off, `publish`, `all`,
  whitespace, garbage → `all`; takedowns: both forms, comments, a bad line
  reported by number while the rest applies.
- `host-core.test.ts` — create → live + lease; renew extends; **10 000 renewals
  across a simulated year stay live (no maximum — owner Q4)**; lapse → offline
  view before the sweep; sweep → content-removal effect + `expired`; renew on
  expired → `expired`; owner `PUT` revives the same id; another key → `forbidden`;
  delete → `deleted` + 410 view; tombstone expiry → record removal → 404;
  every cap in the table at its limit and one past it (incl. `newKeysPerDayPerIp`
  and `minFreeDiskBytes` via an injected free-bytes); reservation released on a
  store failure (counts unchanged); collision retry and exhaustion; bandwidth
  cap → 503 view, reset at the next UTC day; kill `publish`/`all` matrix;
  takedown by app and by key, un-blocking, race with an in-flight PUT; restart
  from records + snapshot: live-at-snapshot → fresh TTL, lapsed-at-snapshot →
  expired, deleted stays deleted, orphans reported. *Mutations:* remove the
  snapshot extension → restart test red; let renew succeed on `expired` → red.
- `pages.test.ts` — `visitorView` matrix (only `same-origin`+`navigate`+`document`
  → app; `same-site`, `cross-site`, `none`, missing → warning); the app header
  set exactly (each directive asserted); every page's CSP hash equals the hash
  of its own inline script/style; the warning carries the Report link with the
  id and the escaped abuse e-mail; no template contains `Set-Cookie` or an
  external URL besides the configured ones. *Mutations:* drop `connect-src
  'none'` → red; accept `same-site` as app → red.
- `store.test.ts` (real fs in a `mkdtemp` dir) — atomic writes (no partial
  file visible), content named by hash, update unlinks the old content after
  the record, orphan scan, unknown `v` skipped and file untouched, an injected
  ENOSPC leaves no tmp and the old record/content intact.
- `server.test.ts` — end to end over HTTP with `Host` headers: signed create →
  `201` + url; visit with `Sec-Fetch-Site: none` → warning, with `same-origin`
  → the exact bytes + headers; **no `Set-Cookie` on any route** (a sweep over
  every route and status); 413 (oversized), 415, 400 (invalid UTF-8), 404/405
  on the app host; `/healthz` has no counters; XFF keying behind a loopback
  peer with `trustProxy`; report form → stored line, 429 per IP, unknown app
  404, a report never changes the app's view; ENOSPC on update → `507` and the
  old version still served; kill switch file flips within the staleness bound.
- `main.test.ts` — flags + env, flag wins; missing `--domain`/`--abuse-email`/
  `--terms-url` refused; non-positive limits refused; unknown argument refused.
- `deploy.test.ts` — the unit's `ExecStart` parses with `parseAppsHostArgs` at
  the default host/port with `--trust-proxy`; no secret in argv; the sandbox
  lines and `StateDirectory`/`ConfigurationDirectory` present; the Caddyfile
  proxies to the default port, serves both `*.apps.<domain>` and the apex,
  replaces XFF, strips `Set-Cookie`, `max_size` ≥ `maxAppBytes`, uses `dns`
  (DNS-01) and has no `log`; the runbook's takedown/kill examples parse with
  `parseTakedowns`/`parseKillSwitch`, it names the binary `build.ts` builds, the
  smoke test hits `/healthz`, and it says deploy is the owner's step.

**Unverified by CI, stated:** real-browser behaviour of Fetch Metadata, the CSP
`sandbox` and the warning flow (runbook §5, Safari + Chrome, by the owner at
deploy); `caddy validate` of the site block with the DNS module; the DNS
provider's API. **Gate before done:** `bun run check` (typecheck incl.
`apps/apps-host`, lint clean, full parallel suite with only the three opt-in skips).

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Load-bearing check, re-run before any code** (`bun` 1.4.3, same probes as the
Repro, in `.tentacle/tmp/session-apps-host/probe.ts`) — holds:

```
pub 32 sig 64 ok true tamper false
small 200 {"host":"abc.apps.example","len":100}
big 413
statfs free bytes true
```

**Built, in order:** (1) `packages/protocol/src/apps-host.ts`, its export, the
regenerated `protocol.json`; (2) the two relay `exports` entries, the new
workspace, `bun install`; (3) `limits`, `app-id`, `signed-request`,
`operator-files`; (4) `host-core`; (5) `pages`, `store`; (6) `server`, `main`;
(7) `deploy/` (build script, unit, Caddy block), the runbook, `package.json`
`typecheck`, `AGENTS.md` §6, `changelog.d/session-apps-host.added.md`. No
`PROTOCOL_VERSION` change and no `protocol.d/` note: not an RPC addition.

**Red before green — what was and was not seen:**

- Seen red first (module missing): the protocol test, `app-id`,
  `signed-request`, `operator-files`, `pages`, `store`, `deploy`.
- **Not** run before their code existed: `host-core.test.ts`, `server.test.ts`,
  `main.test.ts`. Their non-vacuity rests on the mutations below.

**Mutations** (each applied alone, run on its test file, reverted):

| Mutation | Result |
|---|---|
| drop `domain` from the signing payload | 2 fail: pinned golden string; "changing any part changes the payload" |
| skip the nonce guard | 2 fail: "a second use of a nonce → replay"; "a full cache → busy" |
| restore keeps the old lease instead of a fresh TTL | 2 fail: "live at the snapshot → a fresh TTL"; "published after the last snapshot" |
| renew succeeds on `expired` / lapsed | 1 fail: "a lapsed lease is offline before the sweep" |
| drop `connect-src 'none'` | 2 fail: "exactly this set"; "each directive that closes a way out" |
| accept `same-site` as the app | 1 fail: "everything else gets the warning" |
| (extra) no per-id write queue | 1 fail: "a revive waits for the expiry's cleanup of the same id" |
| (extra) only `--domain` required | 1 fail: "each required value is refused when missing or blank" |
| (extra) a bad signature is let through | 1 fail: "unsigned, forged, replayed and skewed requests touch nothing" |

**Drift from the Implementation** (no step contradicted the code):

- Three extra source files: `records.ts` (shared shapes), `rate.ts` (bounded
  windows), `routes.ts` (pure control routes + error → status).
- **Store writes are queued per id** (`server.ts`, `serial`). The plan did not
  say it: without it an expiry's pending cleanup removes the content file a
  revive with the same bytes has just written (the extra mutation above).
- Restart: the lease compared with `aliveAt` is the later of the snapshot's and
  `updatedAt + leaseMs`, so an app published after the last snapshot (or with no
  snapshot yet) is not expired. The start-up scan treats a file no **live**
  record names as an orphan (not "no record"), and never touches a skipped
  record's files.
- Choices the plan left open: `cap_reached` → HTTP 409; `DELETE` of a deleted
  app → 204 again (so a failed cleanup can be retried), of an expired one →
  deleted, of a taken-down one → 403; a report day-file is removed once its
  start is older than the retention (no report outlives 30 days); an unreadable
  `takedowns` keeps the last good entries; the warning drops the URL fragment
  (a fragment-only navigation would not reload); `--domain` must be a bare name
  and `--terms-url` http(s).
- The unit carries `abuse@tentacle.so` and `https://tentacle.so/terms` as the
  values to confirm (runbook §0).
- `Store.content` returns a `Bun.file` (or bytes, in the memory store).

**Checks run by the executor:** `bun test apps/apps-host/test
packages/protocol/test scripts/test/release.test.ts
scripts/test/changelog-guard.test.ts apps/relay/test` → 1029 pass, 0 fail;
`tsc -p apps/apps-host --noEmit` clean; `biome check` on the changed files
clean. The full `bun run check` is the orchestrator's gate, not run here.

**Loopback smoke** (`main.ts` from source; the publish script is the runbook's
own §5 block): `201` + url; visit without Fetch Metadata → warning, same-origin
navigation → the 53-byte app; a 10 MiB + 1 body → 413; `SIGTERM` → exit 0 with
a lease snapshot on disk.

**Unverified:** the compiled binary (`deploy/build.ts` was not run: the command
needed an approval this session did not have — run `bun
apps/apps-host/deploy/build.ts`); `caddy validate`, the Containerfile and the
podman steps; `systemd-analyze verify`; real-browser behaviour (runbook §5).

**Residuals for Review:** a `413` from Bun's own body limit carries none of the
host's headers; for up to `skewMs` after a restart a publisher whose clock runs
behind gets `409 replay` with no `serverTime`; key blocks do not apply if
`takedowns` is unreadable at start; tombstones are bounded only by the create
rate limits; a signed-shaped but forged upload is read (≤ 10 MiB) before it is
refused, bounded per address but not in total concurrency (`MemoryMax=512M`).

## Review

*(empty until review — mandatory fresh-context Opus review)*
