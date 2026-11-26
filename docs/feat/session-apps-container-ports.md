# feat/session-apps-container-ports — a container's web port at `<id>.apps.tentacle.so`, behind a secret link

> **Status:** implementation (APPROVED — orchestrator, owner-delegated; see *Orchestrator decisions*). Nothing is deployed before the owner says the 27/11 demo is over.
> **Branch:** `feat/session-apps-container-ports` (umbrella doc; slices S1–S3 on this branch in order, S4 TUI after, S5 phone on its own branch)
> **Type:** feat · **Size:** L → split (S1 M · S2 M · S3 M · S4 S · S5 S–M) · **Blast:** load-bearing (what a workload exposes to the internet; a new public surface on the apps host) · **Suited:** Opus plan; Sonnet exec per slice; **mandatory fresh-context Opus security review per slice** (S1 and S3 above all)
> **Changelog:** `changelog.d/session-apps-container-ports.added.md`, written by S4 (the first slice where an owner can use it end to end), stating it is OFF by default

## Context

*— claude-opus-5-5, 2026-11-26*

Session-apps phase P5 (`docs/feat/session-apps.md` §6–§7; TODO item
`feat/session-apps-container-ports`, owner 26/11 ~22:45 «partiamo subito con P5»).
The serve already shows a running container's web port privately on the paired
devices (`feat/container-apps-devices` S1, merged b8d25c4e). P5 adds a public URL
for the same thing: `https://<id>.apps.tentacle.so/`, through a tunnel that the
`serve` **dials out** to the apps host. No port opens on the user's side, and we
**do not wait for `feat/a2a-relay`**.

Binding owner decisions (TODO item; `session-apps.md` answers 5–7 and the
10:05/10:10 interim notes):

- Access is by a **secret capability link** by default. The serve checks the
  secret in the URL and exchanges it for an `HttpOnly` cookie on that app's origin.
- Every exposure is asked through the session's **single broker**. Never «always».
- HTTP/1.1 + WebSocket only, so dev servers with hot reload work. No raw TCP.
- On the apps host: per-app bandwidth/connection caps, a Report link, the kill
  switch and takedown, as for static apps.
- The S1 rules carry over: the ask shows engine facts only, unsafe containers are
  refused, the port is re-resolved per connection, and the exposure lives only as
  long as the session.
- Interim: domain `apps.tentacle.so`, on the tentacle.so box. Deploys of apps-host
  or relay changes need the owner's OK, **after the 27/11 demo**.

**Conflicting records, resolved conservatively.** Answer 7 (10:00) says «never
public»; the TODO line (22:45) says «fully public only as an explicit
per-exposure choice in the ask». This task builds the **secret link only**. Public
mode is Owner question Q2. Leaving it out is stricter, so the approval stands.

**Repro (capability missing), 2026-11-26, `516a6248`:** a ripgrep count over
`packages/` and `apps/` (`*.ts`) for `container_share|apps-tunnel|preview_link|/tunnel` → **0 matches**.
No tool proposes a public exposure, the apps host has no tunnel route and no live
app kind, and the serve has no outbound tunnel.

## Implementation

*— claude-opus-5-5, 2026-11-26*

### Load-bearing assumption

**Bun's own HTTP stack, at both ends, can carry each visitor request or WebSocket as one
stream over ONE outbound, signed WebSocket per app (serve → apps host). The serve
then makes a FRESH loopback connection per request to a re-resolved port and
follows nothing.** Proved with a scratch probe on Bun 1.4.3
(`.tentacle/tmp/session-apps-container-ports/probe.ts`, `probe-upgrade.ts`):

```
ws header=abc proto=vite-hmr                 ← WebSocket client sends custom headers (the signed upgrade) + subprotocol
ws reply=echo:hi protocol=vite-hmr
keepalive:false 5 requests -> 5 client ports ← one TCP connection per request (default pools: 1 port)
default 5 requests -> 1 client ports
stream body=c1;c2;c3;                        ← Bun.serve streams a Response fed asynchronously
new URL("//evil.example/x", base).origin = http://evil.example   ← why the origin is re-checked after building the URL
redirect manual -> status 302 location http://169.254.169.254/latest  ← never followed
open protocol=vite-hmr / text:hi / binary:1,2,9 ← apps host can AWAIT the serve's answer, then upgrade with the chosen subprotocol; text/binary kept
```

Consequences pinned by tests:

- Upstream `fetch` always runs with `keepalive: false` and `redirect: "manual"`.
- The upstream URL is built and then `url.origin === fixedOrigin` is asserted.
  Bun's default pooling would silently break the per-connection re-resolve.

### Preconditions

- **Reused S1 seams (merged):**
  - `SessionPreviews.connect(previewId)` re-inspects by the recorded FULL id with
    no cache. It removes the row when the container no longer qualifies or when
    the inspect answers for another container or port, and keeps it on a
    transient engine error (`packages/daemon/src/session-previews.ts:79-109`).
  - `PreviewFacts`, `PreviewResolver` and `PreviewsLink` are in
    `packages/core/src/previews.ts:22-76`. `previewTargetOf` refuses host-net and
    privileged containers plus socket mounts (`packages/docker/src/preview-target.ts:86-107`).
  - The `container_preview` ask treatment has three parts: never auto-approved
    (`packages/core/src/permission.ts:421`), once-only (`:456`), owner-only for
    external callers (`:152`). The client maps by tool name at
    `packages/client/src/permission-router.ts:169`, the external asks at
    `packages/daemon/src/external/asks.ts:84`.
  - The tool is offered only through the host's lazy link: `packages/cli/src/wiring.ts:1513-1519`
    and `serve.ts:283-285, 831`. It is never offered to the worker, a pod daemon
    or a sub-agent.
  - The ask is built from engine facts through a `line()` sanitizer
    (`packages/tools/src/container-preview.ts:28-60`). `PreviewRow` is defined at
    `packages/protocol/src/preview.ts:28-40`, and the `previews` update is
    display-class (`packages/protocol/src/updates.ts:465`).
  - The device gate for tunnel methods is at `packages/daemon/src/connection.ts:555-560, 642-681`.
- **The apps host:**
  - It is a loopback Bun process behind Caddy (`apps/apps-host/src/server.ts:52-55`).
    It routes by `Host` (`app-id.ts` `hostRoute`, `server.ts:650-655`).
  - Static apps are GET/HEAD-only through `handleApp` (`server.ts:589-625`).
  - Publishers authenticate with Ed25519-signed headers plus a nonce and a date
    (`signed-request.ts:1-6`), over `appsSigningPayload` (method, domain, path,
    date, nonce, body hash; `packages/protocol/src/apps-host.ts:54-72`).
  - Records hold `ownerKey/state/sha256/bytes` (`records.ts:5-20`). The kill modes
    are `off|publish|all` (`operator-files.ts:16`). Takedowns go by app or by key,
    and are checked in `HostCore.view` and the sweep (`host-core.ts:401-427, 440-460`).
  - All caps live in one table with a flag and an env var each (`limits.ts:16-71`).
    The per-app daily egress check is in `host-core.ts:420`.
  - The cookieless first-visit warning keys on Fetch Metadata (`pages.ts:34-40`,
    `server.ts:609-613`).
  - The apps host already depends on `@tentacle/protocol`
    (`apps/apps-host/package.json`), so a shared tunnel codec can live there.
- **The publisher side:** `AppsClient` (signed requests, `baseUrl` override for
  loopback tests) is in `packages/daemon/src/apps-client.ts:42-89`. The serve's
  Ed25519 key is `apps-key.ts` (`loadOrCreateAppsKey`, `:91`). The domain comes
  from config `apps.domain` (`packages/config/src/key-docs.ts:1036-1047`).
- **Caddy today strips every `Set-Cookie`** (`apps/apps-host/deploy/Caddyfile.apps:15-40`,
  `-Set-Cookie` / `header_down -Set-Cookie`). It caps request bodies at 10 MiB and
  keeps no access log. A capability cookie cannot reach a browser until that
  changes (Q5). This is a deploy-time change, owner-gated.
- **Session lifetime:** `SessionPreviews.close()` runs when the session closes or
  is archived (S1 Design 5). Previews are in memory only (S1 OD6), so nothing is
  persisted and there is **no on-disk format change on the serve**.

### Orchestrator decisions

Owner-delegated: each takes the recommended option. **None weakens an AGENTS §7
rule.** The single broker, the identity side (serve only, never a pod), and the
additive protocol rules are all kept. The two that change an owner condition (Q1
TLS, Q5 cookies) affect only a deploy, which the owner must OK anyway.

- **OD1 — A new tool and ask kind, `container_share {container, port, engine?}`.**
  Same treatment as `container_preview`: once-only, never auto-accepted (the
  serve's own auto-answer included), owner-only for external callers, never offered
  to sub-agents, offered only by a `serve` with `previews.enabled` **and**
  `previews.links`. The title says what is different, in words:
  `Put container <name> port <p>/tcp on the INTERNET behind a secret link?`
  The detail lines are the S1 engine facts plus:
  - `Anyone you give the link to can use this service as you would`
  - `The service can reach your network (LAN) from inside the container`
  - `Traffic passes through apps.tentacle.so (TLS ends there)`
  - `Until you stop it or this session ends`

  A separate kind (not a flag on `container_preview`) means an owner can never
  mistake «on my phone» for «on the internet». It also makes the exhaustive
  `EXTERNAL_ANSWER` map force a decision.
- **OD2 — A stricter container gate for links.** `previewTargetOf({…, scope:
  "link"})` refuses everything S1 refuses, plus:
  - `HostConfig.PidMode|IpcMode|UTSMode === "host"`;
  - `CapAdd` ∋ `ALL|SYS_ADMIN|NET_ADMIN|SYS_PTRACE|SYS_MODULE|DAC_READ_SEARCH|SYS_RAWIO`;
  - a non-empty `Devices`;
  - `SecurityOpt` containing `seccomp=unconfined|seccomp:unconfined|apparmor=unconfined|apparmor:unconfined`.

  Reason: whoever holds the link drives the service. A web terminal or Jupyter is
  remote code execution by design, and these settings turn that into the host.
  This closes the S1 accepted debt (`CapAdd`/`PidMode`) for the public scope only.
- **OD3 — The row and the secret.**
  - An approved share adds a `PreviewRow` with a new optional display field:
    `link: { url: "https://<id>.<domain>/", state: "connecting"|"up"|"down" }`.
    The URL carries **no secret**.
  - The 128-bit secret (base64url) stays **only in daemon memory**. It leaves the
    daemon only as the answer to `session/preview_link {sessionId, previewId}` →
    `{ url: "https://<id>.<domain>/__tentacle/cap/<secret>" }`, which needs an
    **owner principal** (`device` or `token`) with the session open on that
    `Connection`.
  - It never goes into a tool result (so the model never sees it), a
    `session/update`, the session log, the sidecar, or a log line.
  - `session/preview_stop` is opened to `token` principals too: the `connect` TUI
    is the owner, and stopping is not a tunnel.
- **OD4 — The capability gate, on the serve, per request (pure `shareGate`).**
  1. `GET /__tentacle/cap/<s>` with `s` equal to the secret (constant-time
     compare) → `303 /` and
     `Set-Cookie: __Host-tentacle-cap=<s>; Path=/; Secure; HttpOnly; SameSite=Lax`.
     `__Host-` makes the cookie host-only, so it is never sent to `tentacle.so` or a
     sibling app. Lax keeps it on top-level navigations. The 303 means the secret
     is never the document URL, so a `Referer` cannot leak it.
  2. Any other `/__tentacle/*` → 404. It is never forwarded.
  3. A request or WebSocket without a valid cookie → a fixed `403` page («this
     link needs its secret»), with nothing forwarded.
  4. Valid → forwarded with the cookie **removed** from `Cookie`, so the container
     never sees the secret.
- **OD5 — The upstream request, on the serve (pure `upstreamRequest`).**
  - **The target:** only origin-form (`/` but not `//`) is accepted.
    `CONNECT`/`TRACE` and `*` are refused with `400`. The URL is built on the fixed
    `http://127.0.0.1:<hostPort>` and its origin re-asserted. `fetch` runs with
    `keepalive:false, redirect:"manual"`.
  - **Hop-by-hop headers:** `Connection`, `Keep-Alive`, `TE`, `Trailer`,
    `Transfer-Encoding`, `Upgrade` and `Proxy-*` are dropped both ways. The
    visitor's `Forwarded`/`X-Forwarded-*` are dropped.
  - **The headers sent up:** `Host: localhost:<hostPort>`; `Origin` is rewritten to
    `http://localhost:<hostPort>` only when it equals the app's public origin;
    `X-Forwarded-Proto: https` and `X-Forwarded-Host` are added. This is what the
    owner's own browser would send, so the default `allowedHosts` and Origin checks
    of dev servers such as Vite pass. A cross-origin request never gets this far
    (OD7).
  - **Response cookies:** a `Set-Cookie` with a `Domain` attribute, or one named
    `__Host-tentacle-cap`, is dropped. This stops cookie tossing onto `.tentacle.so`
    through headers.
  - **WebSocket:** a Bun `WebSocket` to `ws://127.0.0.1:<hostPort><target>` with
    the visitor's subprotocols and the same filtered headers. Text and binary
    frames are relayed as they are.
- **OD6 — Re-resolve per request, single-flight.** Every stream calls
  `SessionPreviews.connect(previewId)`. Concurrent streams share one in-flight
  inspect, and no result is reused after it has resolved. The staleness bound is
  one inspect's latency, the same TOCTOU as S1's inspect→dial. S3 measures the
  inspect latency on Docker Desktop and on podman-machine, and reports it.
- **OD7 — The apps host's visitor gate for live apps (pure `liveVisitorGate`).**
  - A request passes to the tunnel only with `Sec-Fetch-Site: same-origin`.
  - A top-level navigation without it gets a host-owned **warning page**: «published
    by a tentacle user, not by tentacle», Report, and a **Continue** link. Continue
    is a same-origin link to the very path requested, HTML-escaped, so the next
    navigation passes. This is cookieless, like `visitorView`.
  - Anything else gets `403`.
  - Live apps use no iframe wrapper (`/_frame` belongs to static apps only).
  - Non-browser clients such as `curl` always get the warning: v1 is for browsers.
- **OD8 — Liveness is the tunnel.** A live app's lease is extended by the host's
  sweep while its tunnel is connected; the serve runs no renew loop. Down for
  longer than `leaseMs` (5 min) → `expired`. The serve's next reconnect then gets
  `expired`, and the share ends (row removed, model and owner told). Stop, session
  close or archive → the serve sends a signed `DELETE` and closes the tunnel.
- **OD9 — Limits** (the host's one table, `limits.ts`, plus constants in
  `protocol/apps-tunnel.ts`):

  | Limit | Value |
  |---|---|
  | `maxLiveTunnels` | 200 |
  | `maxStreamsPerApp` | 64 concurrent |
  | `maxLiveStreams` | 4000 |
  | `liveBytesPerDay` | 1 GiB per app, both directions |
  | `liveRequestsPerMinutePerIp` | 600 (dev servers load hundreds of modules) |
  | `liveStreamIdleMs` | 120 s |
  | tunnel ping | 30 s |
  | WebSocket message | ≤ 1 MiB |
  | stream window | 256 KiB per direction, the S1 constants (`PREVIEW_CHUNK_BYTES`, `PREVIEW_WINDOW_BYTES`) |
  | live apps per key | counted in the existing `maxLiveAppsPerKey` 5 (shared with static apps) |

  Request bodies stay under Caddy's 10 MiB.
- **OD10 — Host-forced response headers on live apps:**
  - `X-Robots-Tag: noindex, nofollow`;
  - `Referrer-Policy: no-referrer`;
  - a `Permissions-Policy` that turns off camera, microphone, geolocation,
    payment and USB (anti-phishing; a real need is an owner question later);
  - no `Set-Cookie` with `Domain`.

  The container's CSP and other headers pass unchanged. Live apps have no
  network-off CSP, because they need their own network.
- **OD11 — Ship OFF.** New config key `previews.links` (default `false`; it
  requires `previews.enabled` and `apps.domain`). For local tests, a loopback-only
  apps URL override: if P2 has none, add env `TENTACLE_APPS_URL`, accepted only for
  `http://127.0.0.1|localhost`, mirroring the relay's `ws://`-loopback rule
  (`key-docs.ts:1406`).

### Design

```
visitor ──TLS──► Caddy (*.apps.tentacle.so) ──► apps-host :4200 ──(stream k on the app's tunnel WS)──┐
                                                  liveVisitorGate · caps · kill/takedown · warning   │
serve ◄── wss://apps.tentacle.so/v1/apps/<id>/tunnel (signed upgrade, dialled OUT by the serve) ─────┘
  └─ per stream: shareGate (cookie) → upstreamRequest → SessionPreviews.connect (re-inspect) → fetch/WS 127.0.0.1:<hostPort>
```

**Tunnel codec (shared truth, `packages/protocol/src/apps-tunnel.ts`, pure).**

- **Frame layout:** each binary WebSocket message is `[u8 type][u32 BE stream][payload]`.
- **Frame types:**

  | Type | Direction | Payload |
  |---|---|---|
  | `OPEN` | host→serve | JSON `{method, target, headers: [k,v][], ws?: {protocols}}`, ≤ 16 KiB, ≤ 100 headers |
  | `HEAD` | serve→host | JSON `{status, headers, protocol?}` |
  | `DATA` | either way | ≤ 32 KiB raw |
  | `END` | either way | body finished |
  | `ACK` | either way | u32 bytes |
  | `RESET` | either way | JSON `{reason}` |
  | `WS_TEXT` / `WS_BIN` | either way | one WebSocket message |
  | `WS_CLOSE` | either way | JSON `{code, reason}` |

- **Stream ids:** only the host opens streams and assigns their ids.
- **Bad input:** a malformed frame, an unknown type, a window overrun or an
  unknown stream closes the whole tunnel (code 1008) on the side that saw it.
  Nothing throws out of a handler. A frame that is too large never parses.
- **Versioning:** the apps API stays v1. The new routes are additive, so an old
  host answers 404.

**S1 — apps host: live kind, tunnel route, visitor path** (`apps/apps-host`).

- **Creating a live app:** `POST /v1/apps/live` is signed, with an empty body.
  - It is refused under kill `publish|all`, and for a taken-down key.
  - It counts in `maxLiveAppsPerKey`.
  - It mints an id and writes `AppRecord{kind:"live", sha256:"", bytes:0}`
    (`kind` is optional; absent means static). An older host build sees a live
    record as a static app with no content and serves the offline page.
- **The tunnel:** `GET /v1/apps/<id>/tunnel` (on the apex) is a signed upgrade:
  `checkSignedHeaders` + `verifySignedBody` over the empty body.
  - The owner key must match the app's, and the app must be `live` and kind `live`.
  - It is refused under kill `all`, for a takedown, or past `maxLiveTunnels`.
  - The newest valid tunnel for an id replaces the old one, which is closed. That
    covers a half-open socket after a network blip.
- **The visitor path** (`handleApp` for a `live` view), in order:
  1. `core.view(id)`: kill `all`, a takedown, expiry or over the bytes cap → the
     existing notice pages.
  2. `liveVisitorGate`.
  3. The per-IP rate and `maxStreamsPerApp`.
  4. No tunnel → the offline page `503`.
  5. Otherwise `OPEN`, then await `HEAD`:
     - a plain response → `new Response(stream, {status, headers + OD10})`;
     - a WebSocket → `srv.upgrade(req, {headers: {Sec-WebSocket-Protocol}})`.

  Visitor body → `DATA` frames with credit. Bytes in both directions are counted
  into `countServed`-style live counters. The cap stops new streams and resets
  live ones.
- **The sweep:**
  - It extends the lease of a tunnel-connected live app (OD8).
  - It closes the tunnels of apps that are taken down, under kill `all`, or
    expired. A request-time `view` also refuses at once.
  - The operator files are re-read at most every 1 s (`operatorStaleMs`).
- **Logs** hold id, status, bytes and reason. **Never** a path, a query or a header.

**S2 — serve: pure gates, the tool, the ask, the row** (no network yet).

- `previewTargetOf` gains `scope: "link"` (OD2).
- The kind `container_share` goes into the core sites; the tool is `container-share.ts`.
- `SessionPreviews.addShare(facts)` mints the secret and the row with
  `link.state: "connecting"`.
- The pure `share-gate.ts` holds `shareGate` (OD4) and `upstreamRequest` /
  `filterResponseHeaders` (OD5). `liveVisitorGate` (OD7) belongs to the apps
  host and ships in S1.
- Protocol: `PreviewRow.link?`, `session/preview_link`, and `preview_stop` for
  token principals.

**S3 — serve: the tunnel client and its lifecycle** (`packages/daemon/src/share-tunnel.ts`).

- `AppsClient.createLive()` and `signTunnel(id)` produce the signed headers for
  the upgrade.
- Each share holds one `ShareTunnel`:
  1. create the live app, then connect;
  2. on a drop, reconnect with backoff (1 s → 30 s, a fresh signature each time);
  3. on `expired`, `taken_down` or `forbidden` → end the share and remove the row,
     with the host's reason shown to the owner and returned to the model at its
     next tool call (the row's removal is the signal);
  4. on a stream, run `shareGate` → `connect()` (single-flight) → fetch or WS.
- Credit windows on both sides; `ACK` after the upstream write.
- Lifecycle: the row removed (stop, gone, session close/archive) → `DELETE` + close.
  The daemon stopping → all tunnels close (the host serves offline at once).
- `link.state` updates are emitted through `previews`.

**S4 — TUI `/previews`** (`connect` to a serve). A pure view-model lists rows
(name, port, «link · up/down»). Copy link calls `session/preview_link` and uses
the TUI's existing clipboard path; Stop calls `preview_stop`. It writes the
changelog fragment.

**S5 — phone (own branch, after S4).** A hub entry «Links» listing shared rows,
with Copy/Stop. Mockups first (≥ 2 variants, `.tentacle/mockups/<slug>/`). It may
be folded into `feat/container-apps-devices-phone` if that is planned first.

### Files

In dependency order:

1. **S1:**
   - `packages/protocol/src/apps-tunnel.ts` (new: codec + limits) + `index.ts`;
     `apps-host.ts` (`AppsLiveCreate` result, if it differs from `AppsLeaseResult`).
   - `apps/apps-host/src/records.ts` (`kind?`), `host-core.ts` (live view, tunnel
     admission, lease-by-tunnel, live byte counters), `limits.ts` (OD9 rows),
     `routes.ts` (`create_live`, `tunnel`), `pages.ts` (`liveWarning`, `needsSecret`
     is the serve's; OD10 headers), `server.ts` (`websocket` handler, the visitor
     path); `live-tunnels.ts` (new: the registry, streams, credit).
   - `apps/apps-host/deploy/Caddyfile.apps` (Q5: drop the blanket `Set-Cookie`
     strip; `flush_interval -1` for streaming) — **edited here, deployed only with
     the owner**. Plus `docs/ops/apps-host-deploy.md` (the step).
2. **S2:**
   - `packages/docker/src/types.ts` (`PidMode`, `IpcMode`, `UTSMode`, `CapAdd`,
     `Devices`, `SecurityOpt`), `preview-target.ts` (`scope`).
   - `packages/core/src/permission.ts` (kind `container_share` at `:78`, `:152`,
     `:421`, `:456`), `previews.ts` (`CONTAINER_SHARE_TOOL`, `PreviewsLink.addShare`).
   - `packages/tools/src/container-share.ts` (new) + export;
     `packages/agent/src/subagent.ts` (filter, both lists).
   - `packages/protocol/src/preview.ts` (`link?`, `PreviewLinkParams/Result`),
     `methods.ts`, `session.ts` (if the snapshot row type is separate).
   - `packages/daemon/src/share-gate.ts` (new, pure); `session-previews.ts`
     (`addShare`, secret, link state); `connection.ts` (`preview_link`, token
     principals on `preview_stop`); `external/asks.ts`.
   - `packages/client/src/permission-router.ts`, `mapping.ts` (`link`),
     `remote-session.ts` (`previewLink`, `previewStop`).
   - `packages/config` (`previews.links` + `key-docs.ts`).
   - `packages/cli/src/wiring.ts` (offer `container_share`), `serve.ts`.
   - `packages/tui/src/permission-ui.ts` + `apps/mobile/src/permission-sheet.ts`
     (labels `Share once` / `No`, so the owner can answer from either).
3. **S3:**
   - `packages/daemon/src/apps-client.ts` (`createLive`, `signTunnel`),
     `share-tunnel.ts` (new), `session-previews.ts` (start/stop tunnels),
     `packages/cli/src/serve.ts` (apps key + client into the resolver context).
4. **S4:**
   - `packages/tui/src/previews-view.ts` (new, pure), the `/previews` command and
     its renderer; `changelog.d/session-apps-container-ports.added.md`.
5. **S5:** its own doc.

### Failure modes

| Case | Convergence |
|---|---|
| Visitor tries a pivot: `GET http://192.168.1.1/`, `//evil/x`, `CONNECT host:22`, `TRACE` | `400` on the serve; nothing dialled. The upstream origin is fixed and re-asserted; redirects are never followed. |
| The container is itself an open proxy or reaches the LAN | Not preventable by us: the ask says so (OD1). Access needs the secret; a stricter container gate applies (OD2). Q4 covers enforcing an internal-only network. |
| Container replaced or stopped, and the port is taken by something else | Re-inspect by full id per request → the row is removed and the share ends with a `DELETE`. A raw stored port is never dialled. |
| Engine unreachable | `502` for that request; the row is kept (S1 transient rule). |
| Secret leaked (forwarded chat) | Stop → `DELETE`: dead at once. Stopping and sharing again gives a new id and a new secret. |
| Brute force on `/__tentacle/cap/*` | 128 bits; plus the per-IP rate. No oracle: a wrong secret gives `404`, the same as any unknown path. |
| The container sets `Set-Cookie; Domain=.tentacle.so` | Dropped on the serve. JS `document.cookie` can still do it (no CSP on live apps): an interim residual until the separate PSL domain. Stated in Q5. |
| Phishing container shared by an attacker running their own serve | The warning page + Report, per-key caps, a key takedown (closes its tunnels), the kill switch. The secret does not protect visitors; the warning does. |
| Tunnel drops (laptop sleeps, network) | Visitors get the offline `503` at once. The serve reconnects with backoff; after 5 min → `expired` → the share ends and the owner is told. |
| Two tunnels for one id (half-open old socket) | The newest signed one wins; the old one is closed. |
| Replayed tunnel upgrade | The nonce cache and the date skew refuse it (existing `NonceGuard`). |
| A malformed frame or a window overrun from either side | The tunnel closes (1008); streams reset; the serve reconnects. No unbounded buffering: 64 × 256 KiB per app at most. |
| Kill `publish` / `all`; takedown of app/key | `publish`: no new live creates or tunnels, existing ones run. `all` / takedown: tunnels closed on the next sweep (≤ 10 s) and refused at request time at once. |
| Daily byte cap hit | New streams get the notice page; live streams reset. |
| Session close/archive, `preview_stop`, serve stop | `DELETE` + close (best effort); on failure the host's lease expiry converges in ≤ 5 min. No serve persistence: a restart forgets the share. The app is down at once (tunnel gone) and `expired` later. |
| Model asks for a share on a worker or pod daemon, or a sub-agent does | The tool is not offered (wiring tests). |
| Auto-accept on (client or the serve's own) | `autoApproves` excludes `container_share`. |
| An external caller (A2A/MCP) answers or reads | It cannot answer (owner-only). `preview_link` needs a device or token principal on a Connection. |
| Secret in persistent or model-visible places | Never written: pinned by a test that greps every emitted update, tool result, persisted state and log line for the secret. |
| Old client/daemon/host pairs | All additive: an unknown method → `MethodNotFound`; an unknown route → 404 → the share fails with the reason. No `protocol.d/` note; if the executor finds something non-additive, STOP and write `protocol.d/session-apps-container-ports.md`. |

### Tests

Red before green, on the property's assertion. Non-vacuity is shown by the named
mutation.

- **S1:**
  - `packages/protocol/test/apps-tunnel.test.ts`: round-trip of every frame type;
    refusal of an oversize `OPEN`, a bad type, a truncated header.
    *Mutation:* drop the size check.
  - `apps/apps-host/test/live.test.ts` (a real `startAppsHost` on `port: 0`, kept
    bound; a fake serve = a Bun `WebSocket` with signed headers):
    - an unsigned or wrongly-keyed upgrade is refused;
    - a replay is refused;
    - the visitor path: a request without `Sec-Fetch-Site: same-origin` → the
      warning page, and the fake serve got **0** `OPEN`; a same-origin request →
      `OPEN` with method, target and headers;
    - a streamed body arrives and a WebSocket echo works;
    - `maxStreamsPerApp + 1` → `503`;
    - no tunnel → the offline page;
    - kill `all` → the tunnel is closed (`until`, no sleep), and so is a key
      takedown;
    - lease extended while connected; after `leaseMs` disconnected → `expired`;
    - no log line contains the request path.

    *Mutations:* gate always `"app"`; no ownership check; no close on takedown.
  - `apps/apps-host/test/server.test.ts`: a static or control response never
    carries `Set-Cookie` (pins Q5's process-side guarantee).
- **S2:**
  - `preview-target.test.ts`: the link scope refuses `PidMode: host`, each listed
    cap, devices and unconfined seccomp; the device scope still accepts them (S1
    unchanged). *Mutation:* ignore `scope`.
  - `permission*.test.ts`: `container_share` is not `autoApproves`, is
    `onceOnlyAsk`, and is owner-only.
  - `container-share.test.ts`: the ask shows the engine's name and image, not the
    model's, plus the internet/LAN lines; decline → no `addShare`; the tool result
    contains the URL **without** the secret.
  - `share-gate.test.ts`:
    - cap exchange → 303 + `__Host-` attributes;
    - wrong secret → 404;
    - no cookie → 403;
    - the cookie is stripped upstream;
    - `//x`, `http://…`, `*`, `CONNECT` and `TRACE` → 400;
    - the origin is re-asserted;
    - the `Host`/`Origin` rewrite only for the app's own origin;
    - `Domain`-cookies are dropped.

    *Mutations:* drop the `//` check; non-constant-time compare (not observable;
    skip); forward the cookie.
  - `connection-preview.test.ts`: `preview_link` from a token principal works;
    pairing → `Unauthorized`; session not open → `UnknownSession`.
  - **The secret-hygiene test:** one share → every captured update, tool result,
    persister capture and log line lacks the secret.
  - The wiring tests (only serve with both flags; not the worker, pod, or sub-agents).
- **S3:**
  - `share-tunnel.test.ts` (a real local apps host from S1 plus a real loopback
    HTTP+WS upstream the test binds):
    - end to end: cap → cookie → page → WS echo;
    - the per-request re-resolve: the fake resolver changes the port between two
      requests → the second dials the new one. *Mutation:* cache the target. It also
      pins `keepalive:false`: the upstream counts connections;
    - container gone → the row is removed and `DELETE` sent;
    - a host-side `expired` → the share ends;
    - backoff reconnect after the host restarts;
    - session close → `DELETE` + closed;
    - a window overrun from the host → the tunnel closes and reconnects.
- **S4:** the `previews-view` pure tests; the `/previews` frame via
  `ink-testing-library`; copy calls `preview_link`.

**Local validation** (S3 exit; no deploy; the script and output pasted into
Execution):

1. Start apps-host:
   `bun apps/apps-host/src/main.ts --domain apps.localhost --port 4200` with a
   data dir under `.tentacle/tmp/session-apps-container-ports/`.
2. Start serve with `apps.domain: apps.localhost`,
   `TENTACLE_APPS_URL=http://127.0.0.1:4200`, `previews.enabled` and `previews.links`.
3. Start the containers:
   `podman run -d --name p5-nginx -p 127.0.0.1:8080:80 docker.io/library/nginx:alpine`,
   plus a WebSocket echo container on `127.0.0.1:8081`.
4. From `connect`, ask the model to share `p5-nginx` port 80 and approve.
5. With `curl -H 'Host: <id>.apps.localhost'`, check:
   - (a) no Fetch Metadata → the warning;
   - (b) same-origin without a cookie → 403;
   - (c) the cap path → 303 + cookie;
   - (d) with the cookie → nginx's page;
   - (e) `GET //evil/` → 400, and nginx's log shows no such request;
   - (f) a WebSocket echo through the tunnel with the cookie.
6. Lifecycle checks:
   - (g) `podman stop p5-nginx` → the next request fails and the row is gone;
   - (h) the kill-switch file `all` → closed within one sweep;
   - (i) stopping serve → offline 503 at once;
   - (j) `/previews` Stop → 410/offline.
7. Optional: a Vite dev server in `node:22` with HMR edited live.

**Deploy (owner, after 27/11):** the Caddy change (Q5), the apps-host binary,
`previews.links` on the owner's serve. The live check repeats (a)–(j) over https.

### Owner questions

Each one is decided as recommended under *Orchestrator decisions*. Veto before the
deploy.

1. **Where TLS ends.**
   - **What we do:** TLS ends at Caddy on the apps box, so the apps-host process
     (on the owner's own box) handles visitor traffic and the secret in clear. It
     logs none of it.
   - **The alternative:** TLS passthrough with the serve's own certificate (the
     `feat/a2a-relay` design) — wait for it.
   - *Recommendation:* end TLS at the apps box now, say so in the ask, and move to
     passthrough when a2a-relay exists. A blocker before other users' apps run
     there (privacy note).
2. **Public mode** (no secret), as an explicit per-exposure choice.
   - **Status:** the records conflict (answer 7 «never public» vs the TODO).
   - *Recommendation:* not in this task. Add it later as a small slice (a
     `public: true` tool flag with its own red ask title), only if a real need
     shows up.
3. **Who sees the secret link.**
   - **What we do:** only the owner's clients (`/previews`, phone S5). The model
     gets the URL without the secret.
   - **The alternative:** the model sees it and pastes it in chat. That is
     simplest, but the secret lands in the session log and in the model's
     reach.
   - *Recommendation:* owner clients only.
4. **LAN pivot by the container's own egress.**
   - **What we do:** warn in the ask.
   - **The alternative:** refuse a container unless its network is
     `Internal: true`. That breaks most dev setups.
   - *Recommendation:* warn now, plus the stricter OD2 gate.
5. **Cookies through Caddy.**
   - **What we do:** remove Caddy's blanket `Set-Cookie` strip. The process
     guarantees no cookie on static and control responses (a test), and only
     host-only cookies on live apps.
   - **Note:** this relaxes the 10:05 interim «the apps host sets no cookies» for
     live apps only. Residual: JS cookie tossing onto `.tentacle.so` from a live
     app, until the separate domain on the Public Suffix List.
   - *Recommendation:* yes. Nothing on `tentacle.so` uses cookies today
     (the relay is Noise). Verify the landing page at deploy.
6. **Warning page for live apps:** the Continue page (OD7), not the static
   iframe wrapper. *Recommendation:* yes.
7. **Caps** as in OD9 (live apps share the 5-per-key cap with static apps).
   *Recommendation:* yes; tune after real use.

## Execution

*(empty — slices S1 → S5)*

## Review

*(empty — mandatory fresh-context Opus security review per slice)*
