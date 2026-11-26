# eval/session-apps — the agent publishes public web "apps" tied to a live session

> **Status:** review (verdict below; owner decides)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** L if built (split into 6 phases, S–M each, below) · **Blast:** load-bearing (a new public hosting surface, a new tool whose effect leaves the laptop — AGENTS §7 identity gate —, per-session state persisted on `serve`) · **Suited:** Opus plans every phase + mandatory fresh-context Opus review; DeepSeek/Sonnet may execute the contained phases (host service, phone UI)
> **Changelog:** none (an eval ships no code)

## Context

*— claude-opus-5-5, 2026-11-26*

**The owner's request (2026-11-26 ~08:30, verbatim):** «Eval su possibilità di
permettere all'utente di pubblicare "apps" su tentacle.so, saranno solo pagine
html css js che tentacle potrà pubblicare (per ora tutte pubbliche) e legate alla
sessione (sessione viva, app up) esposte tipo su `<id>.apps.tentacle.so`».

**Owner addition (same day, via the coordinator):** «Bonus, possibilità di
esporre apps dal serve puntando una porta di un container (docker/podman)
eseguito sull'host del serve» — besides static pages, an app may be a LIVE
service: `<id>.apps…` forwarded to a port of a container on the `serve`'s host.

**The question being decided:** should tentacle let the agent (with the user's
approval) publish static HTML/CSS/JS "apps" at a public per-app URL whose
lifetime is the session's lifetime — and if yes: (1) how the bytes are served
(uploaded to our host vs served live from the user's `serve` through the relay),
(2) on which domain and with which TLS, (3) how abuse and secret leaks are
contained and who approves a publish, (4) the tool/protocol/UI shape across
runtimes, (5) the cost and the legal duties of hosting third-party content on the
one Caddy box, (6) the smallest useful first slice — and, as a bonus, whether and
how a live container port can be exposed the same way.

**What exists today (verified):**

- **Artifacts are already a thing.** The `present` tool shows the user an HTML /
  image / PDF / Markdown artifact as a transcript card + gallery entry
  (`packages/tools/src/present.ts:1-12`, design `docs/feat/model-artifacts.md`).
  It reads only through the CONFINED reader: workspace files, secret-looking names
  refused (`present.ts:8-10`, `packages/core/src/secret-path.ts`). Its HTML runs
  with the network blocked (`present.ts:37`; the CSP wrapper is
  `packages/core/src/artifact-csp.ts:51-56`). The bytes are an immutable,
  content-addressed snapshot in a per-session store (`packages/daemon/src/artifact-store.ts:1-20`),
  read back over `artifact/read` (`packages/protocol/src/methods.ts:269`). `present`
  is `permission: "none"` — SHOWING, never acting. **A published app is the same
  bytes, but ACTING**: it leaves the laptop and becomes public.
- **The relay** (`apps/relay/`, `relay.tentacle.so`) is a dumb splicer: a `serve`
  dials OUT one control socket and one data socket per phone stream
  (`packages/daemon/src/relay-link.ts:2-11`); the relay "holds no key, verifies no
  peer and authorises nothing" (`apps/relay/src/server.ts:15-17`) — phone↔serve is
  Noise end-to-end. It binds loopback because **Caddy terminates TLS in front of
  it** (`server.ts:46`, `apps/relay/deploy/Caddyfile.relay`). A daemon dials the
  relay only while a paired device wants it reachable
  (`relay-link.ts:228-230`, `:514`; `packages/daemon/src/device-authority.ts:240`).
  Abuse limits are per IP and per daemon id; notably **64 concurrent streams per
  daemon id** (`apps/relay/src/relay-core.ts:45-53`, `:51`).
- **The public A2A route through the relay is designed but NOT built**
  (`TODO.md` → `feat/a2a-relay`: TLS passthrough by SNI to `<id>.a2a.tentacle.so`,
  the serve getting its own certificate via DNS-01 through a relay-side endpoint).
  `feat/a2a` (the serve's A2A route, `packages/cli/src/serve-a2a.ts`,
  `packages/daemon/src/a2a/http.ts:26`) is merged.
- **Hosting:** one box, `142.132.169.22` (`docs/ops/relay-deploy.md:15`), Caddy
  2.8.4 in podman, sole owner of :80/:443, certificates by HTTP-01 per name
  (`.tentacle/site/Caddyfile`, gitignored; header comment). The same box serves
  `tentacle.so` (static + `install` script), `relay.tentacle.so`, AND an unrelated
  business app (`gestionale.farci.to`). No wildcard certificate, no DNS-provider
  module in the stock Caddy image (not verified on the host — it runs the stock
  image per the owner's notes).
- **Session lifetime on `serve`:** a session ends by `session/close`, the idle
  TTL (default 24 h, `packages/daemon/src/session-reaper.ts:19`, `never`
  allowed — `docs/feat/session-ttl-control.md`) or the detached cap; it is then
  ARCHIVED, revived only by an explicit `session/open{reopen}` (AGENTS §7).
- **Permissions:** `PermissionLevel = "none" | "ask" | "deny"`
  (`packages/core/src/tool.ts:17`); the broker can grant `allow_always`
  (`packages/protocol/src/permission.ts:38`). The pod-to-laptop tunnel pattern for
  "identity stays on the laptop" is `ProxyModelProvider`
  (`packages/daemon/src/proxy-model.ts:194`).
- **Containers:** every container tentacle creates carries `tentacle.managed`
  (`packages/docker/src/client.ts:77`); `run`'s container has no host network/pid
  (`packages/cli/src/engine-docker.ts:96`), an optional engine network
  (`--network`, `engine-docker.ts:110`); the client can inspect a container
  (`client.ts:331`); the engine may be local (`unix://`) or REMOTE (`tcp://`,
  `ssh://`, `packages/docker/src/engine-endpoint.ts:247`).

**Not verified** (stated, not guessed): the DNS provider of `tentacle.so` and
whether it has an API Caddy supports; the box's traffic allowance; the current
Public Suffix List and Let's Encrypt rate-limit numbers (from memory: 50 new
certificates per registered domain per week; PSL inclusion takes weeks and needs
a long-registered domain) — re-check before Phase 0; legal points are an
engineer's reading, not legal advice.

## Analysis

*— claude-opus-5-5, 2026-11-26*

### 1. Serving model

**(a) Upload.** On an approved publish, the publishing process uploads the app's
files to a small **apps host** we run; the host serves them as static files.
"Session alive" is a **lease**: the publisher renews it (e.g. every 60 s, TTL
5 min); on unpublish, session end or lease expiry the host drops the files
(keeping a tiny tombstone — id, publisher public key — so the same publisher can
bring the same URL back after a laptop sleep).
- + Visitors never reach the user's machine: no new inbound surface on a laptop
  or home server; a popular page costs the user nothing.
- + Works in EVERY runtime (worker, `serve`, `connect`, pods via the laptop) —
  it needs only an outbound HTTPS call, not the relay link (which today dials only
  for paired devices, `device-authority.ts:240`).
- + Takedown is total (delete the files), content can be inspected on a report.
- − The operator stores third-party content in clear. **For PUBLIC pages this is
  moot**: anyone, the operator included, can load them; there is nothing the
  operator "should not see".
- − Storage + egress on our box (small, see §5).

**(b) Live through the relay.** Visitors hit `<id>.apps…`; the relay forwards
the HTTP(S) bytes over the `serve`'s outbound link; the serve serves the files.
- *TLS passthrough* (the `feat/a2a-relay` design): the relay reads only the SNI
  and pipes ciphertext; the serve terminates TLS with its own certificate
  (DNS-01 through a relay endpoint). The relay sees the id, visitor IPs and byte
  counts — but, again, for a public page that privacy buys nothing.
  Ops: passthrough cannot go through today's Caddy (it terminates TLS for the
  relay, `server.ts:46`); it needs Caddy's layer-4 module or the relay on its own
  IP:443.
- *TLS termination on the relay* (ngrok/Cloudflare-Tunnel style): one wildcard
  certificate, simple — the relay sees everything in clear, which breaks the
  relay's "sees nothing" property for every byte that crosses it.
- − Every visitor reaches the user's serve: an unauthenticated public HTTP
  server inside (or beside) the daemon that holds the model key. Must be a
  separate, minimal static server.
- − Visitor connections are relay streams: **they share the 64-streams-per-id
  budget with the user's own phone** (`relay-core.ts:51`) — a busy page starves
  the user's remote control. Needs a separate budget.
- − Only `serve` (the worker and pods have no relay link); laptop on cellular /
  asleep = app down (that IS the requirement, but uploads give it via the lease
  too).
- − Depends on `feat/a2a-relay`, not built.

**(c) Hybrid.** Static apps by upload (a) with the lease; LIVE apps (the bonus,
§7 below) by the relay (b) when — and only when — something must run on the
user's host.

**Recommendation: (a) with a lease for static apps; (b) only for the live-port
bonus, later, on the `feat/a2a-relay` passthrough infrastructure — i.e. (c) as
the long-term shape, (a) alone first.**

**Liveness — what "session alive → app up" means.** Options: (i) the session is
open (not closed/archived/deleted); (ii) (i) AND its holder is connected
(renewing the lease); (iii) a turn is running. (iii) is far too short (a page
would vanish between prompts). **Recommendation: (ii)** — up while the session
is open on a process that renews the lease. Concretely:
- worker (`tentacle` TUI): up while the TUI is open; quit → unpublish.
- `serve` / `connect`: up while the session is open on the serve (detach does
  not matter); `session/close`, idle-TTL archive, `session/delete` → unpublish
  immediately; serve restart → the reloaded session renews and the app returns.
- pods (`run`/`attach`): the laptop process that owns the session holds the
  lease (§4); laptop quits → down.
- **Grace:** lease TTL 5 min (survives a network blip or a short sleep), and an
  explicit unpublish is immediate. **A hard maximum lifetime** (e.g. 7 days,
  re-approve to extend) even for a `--session-ttl never` session — owner Q4.
- **What a visitor sees when down:** a fixed, host-owned "This app is offline —
  the tentacle session that published it is not running" page, HTTP 503 while
  the tombstone lives (it may come back), 410 after it expires. Never a stale
  copy (cache headers short, service workers blocked — §3).

### 2. Domain and TLS

- **A separate registrable domain for user content is a precondition, not an
  option.** `x.apps.tentacle.so` is *same-site* with `tentacle.so` and
  `relay.tentacle.so`: an app can set cookies for `.tentacle.so` (cookie
  tossing), SameSite does not separate them, and — the practical risk — one
  phishing page reported to Google Safe Browsing / Spamhaus can get **the whole
  `tentacle.so` flagged**, taking down the landing page, `curl tentacle.so/install`
  and the relay the phones depend on. This is why GitHub serves Pages on
  `github.io` and raw files on `githubusercontent.com`. Candidates: a short
  neutral domain (e.g. `tentacle.page`, `tentacle-apps.net`,
  `tentacleusercontent.net` — availability not checked). Owner Q1.
- **Public Suffix List**: submit the new domain to the PSL (private section) so
  every `<id>.<domain>` is its own *site* for browsers (no cookies on the parent,
  isolation between apps) and its own "registered domain" for Let's Encrypt
  limits. It takes weeks and is hard to undo — fine for a dedicated domain, never
  for `tentacle.so`. Until it lands, each app is still its own *origin* (enough
  for storage/DOM isolation), and the CSP below closes the rest.
- **Certificate:** one **wildcard `*.<domain>` by DNS-01**. Per-app certificates
  (Caddy on-demand TLS) are worse twice: every app id lands in the public
  Certificate Transparency logs within seconds (no id stays unlisted) and the
  per-domain issuance limit caps publishes per week. DNS-01 needs a Caddy build
  with the DNS provider's module (`xcaddy`) and a DNS host with an API — choose
  the new domain's DNS host for that (not verified what `tentacle.so` uses).
- **Not on `apps.tentacle.so` even temporarily** — moving a published URL later
  breaks every link and the reputational damage is already done.

### 3. Security and abuse

Public, unauthenticated hosting of agent-generated JavaScript is the classic
phishing/malware magnet (free tunnel and static-host services all fight it; ngrok
added a browser interstitial on its free tier for this reason — recalled, not
re-verified). Defences, cheapest-and-strongest first:

1. **Fixed security headers set by the host** (the page cannot loosen them; a
   `<meta>` CSP can only add): `default-src 'self'; script-src 'self'
   'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:
   blob:; font-src 'self' data:; connect-src 'none'; form-action 'none';
   frame-src 'none'; worker-src 'none'; base-uri 'none'; frame-ancestors
   'none'`, plus `X-Content-Type-Options: nosniff`, `Referrer-Policy:
   no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, short
   `Cache-Control`. Effects: a phishing form cannot submit (`form-action`), no
   fetch/XHR/WebSocket exfiltration or crypto-miner pool connection
   (`connect-src`), no service worker that would keep a taken-down app alive
   (`worker-src`), no embedding in someone else's frame. **Residual:** script
   navigation (`location = "https://evil/?d=…"`) and plain links still leave the
   page — CSP has no navigation control. This matches `present`'s policy
   (network off, `present.ts:37`), so the model already writes self-contained
   pages. Network-on apps (an allowlist per app shown in the prompt) — later,
   owner Q3.
2. **Content allowlist**: `.html .css .js .mjs .json .svg .png .jpg .gif .webp
   .ico .woff2 .txt` only, served with OUR content type; no executables, archives
   or installers (malware distribution); caps per app (10 MiB, 200 files) and per
   publisher (e.g. 5 live apps).
3. **Unguessable ids, no vanity names in v1**: random ≥ 80-bit ids (16 base32
   chars) — no `paypal-login.<domain>` squatting/impersonation. With the
   wildcard certificate the ids are not in CT logs either.
4. **Interstitial on first visit** (per browser, per app: "This page was
   published by a tentacle user, not by tentacle. Continue / Report") — the
   single most effective anti-phishing control for free hosts; costs one click.
   Owner Q5.
5. **Abuse handling**: an abuse contact (`abuse@<domain>`, a report link on the
   interstitial and the offline page), a takedown command on the host (delete by
   id + block the publisher key + optionally its IP), a **global kill switch**
   (refuse new publishes / serve only the offline page), and per-IP / per-key
   publish rate limits. Logs: id, publisher key, IP, size, time — kept 30 days
   (GDPR: a short retention + a privacy note).
6. **No accounts**, like the relay: an app is owned by an Ed25519 key generated
   by its publisher; create/renew/update/delete are signed. Anonymous publishing
   is what makes abuse cheap; the short lease (the attacker must keep a process
   running), the CSP and the interstitial are what make it unattractive. If
   abuse appears, the next step is gating publishes on a registered relay id or
   a proof-of-work, not accounts.
7. **The agent publishing secrets.** Publishing reads only through the same
   confined reader as `present` (workspace only, secret names refused,
   `secret-path.ts`), and only something the user can SEE: v1 publishes an
   artifact already `present`ed (its card is in the transcript). Before upload
   the publisher runs a **secret scanner** on the bytes (private-key headers,
   `AKIA…`, `sk-…`, `ghp_…`, JWT-looking tokens, high-entropy `KEY=` lines):
   a hit is shown in the prompt and blocks unless the user explicitly overrides.
8. **Who approves — AGENTS §7.** Publishing is an effect leaving the laptop: the
   tool is `permission: "ask"`, answered through the session's **single
   broker**, and **every publish and every update asks** — no `allow_always`
   (`permission.ts:38`) for this tool (each version is a new public
   disclosure). The prompt shows the URL, file list, total size, the scanner's
   findings and the lifetime. A sub-agent cannot publish (as for `present`). An
   A2A caller's task can never answer this ask even in `asks: caller` mode.
   **Pods:** the pod daemon must never hold the publish key or talk to the apps
   host; the effect runs on the laptop (§4), which re-checks and prompts itself
   — a daemon-side "already approved" is UX, never security, and no
   pod-originated prompt creates a lasting approval.

### 4. Protocol and product shape

- **Tools:** `publish_app { artifact, version? }` → `{ app, url, expiresAt }`;
  `unpublish_app { app }`. Republishing the same app (a new artifact version)
  keeps the URL and asks again. Phase 4 adds `dir` (a workspace directory with
  `index.html`) through the confined reader.
- **One seam, like the model:** an `AppPublisher` interface injected into the
  daemon's `ToolContext` (as `ArtifactSink` is, `packages/core/src/tool.ts:67`).
  Worker and `serve` get a LOCAL publisher (they are the identity side: the
  worker is the laptop, the serve is the user's trusted host). A pod daemon gets
  a `ProxyAppPublisher` that sends a reverse RPC `app/publish {sha256, …}` to the
  laptop — the `ProxyModelProvider` pattern (`proxy-model.ts:194`): the laptop
  checks the sha is one its own `artifact/list` showed, fetches the bytes with
  `artifact/read`, scans, prompts through the single broker, uploads, holds the
  lease. One session path; only the publisher differs.
- **State:** per session, `apps: [{ app, url, artifact, version, state:
  up|grace|down, expiresAt }]`. A new `session/update` `app_status` of class
  **display** (an older client shows "unsupported" once; no version bump), plus
  a client→daemon `app/unpublish` request (the Stop button; an unknown method →
  `MethodNotFound`). Wire both ends in `@tentacle/protocol` + `client/mapping.ts`.
- **Persistence:** the publisher private key and the app record are durable only
  where the session is: on `serve`, in the session's `<uid>.state.json` sidecar
  (not the log — it is not conversation), so a serve restart renews the same URL.
  The worker/laptop keeps it in memory: a session that ends unpublishes, and
  `--resume` of an ended laptop session does NOT bring the app back (the session
  died → the app died; republishing asks). Pod daemons store nothing (§7).
- **`/clear`:** the source session keeps its apps; the fork starts with none.
- **TUI:** the tool card shows the URL + state; the artifacts panel lists apps
  with a stop key; `/apps` lists/stops. **Phone:** the artifact card gains
  "Live · url · Copy · Stop", plus a hub entry with a badge counting live apps
  (`mobile-hub-vision`); phone parity with the Mac for `serve` sessions.

### 5. Cost, operations, legal

- **Storage**: caps × live apps — 10 MiB × a few hundred live apps is a few GB;
  files exist only while leased. **Egress**: static pages are small; a viral
  page is the risk → per-app bandwidth cap (e.g. 1 GB/day, then the offline
  page) and the kill switch. **CPU**: static file serving by Caddy, negligible.
- **One more public surface on a box that also hosts `tentacle.so`, the relay
  and a third party's business app.** A phishing report or a DDoS against the
  apps IP lands on all of them (IP blocklists are per IP). **Recommendation: a
  separate small VPS (own IP) for the apps host**, a few €/month; acceptable
  alternative: object storage + CDN (e.g. Cloudflare R2 + a Worker for the lease
  and headers — no egress fees) — owner Q2.
- **The host service:** a Bun process like the relay (`apps/apps-host`, loopback
  behind Caddy with the wildcard cert): signed create/renew/update/delete, the
  lease sweeper, the tombstones, caps, the kill switch, a `/healthz`. Static
  serving itself by Caddy `file_server` from a directory the service writes
  atomically, with the fixed headers.
- **Legal (EU/Italy, not legal advice):** this is a *hosting service* under the
  EU Digital Services Act, and since content is disseminated to the public
  probably an *online platform*; the hosting liability exemption holds if we act
  expeditiously on notice. Minimum before going public: terms of use (what may
  not be published), a notice-and-action mechanism (the report link + abuse
  mail), a statement of reasons to the publisher on takedown (shown in their
  session when the host refuses a renew), a single point of contact, a privacy
  notice for the visitor logs (GDPR). Micro/small-enterprise exemptions cover
  most of the heavier platform duties — verify with a lawyer before launch.

### 6. Phased plan (if GO)

| Phase | What | Size | Blast |
|---|---|---|---|
| P0 | Ops/legal, no code: register the domain on a DNS host with an API, PSL submission, VPS (or CDN) decision, terms + abuse contact + privacy page | S | contained (no code) |
| P1 | `apps/apps-host`: signed create/renew/delete, lease + tombstone + offline page, caps, headers, kill switch, takedown CLI; Caddy wildcard (DNS-01) | M | contained (new service; but public — Opus review) |
| P2 | `publish_app`/`unpublish_app` on a `present`ed single-file HTML artifact, worker + `serve`; `AppPublisher` seam; ask-every-time via the single broker; secret scanner; lease loop; unpublish on close/archive/delete; serve sidecar persistence; `app_status` + `app/unpublish`; TUI card + `/apps` | M | load-bearing (new acting tool, broker, persistence) |
| P3 | Phone: card "Live · url · Copy · Stop", hub badge | S–M | contained (mobile) |
| P4 | Pods: `ProxyAppPublisher` + laptop-side gate; multi-file `dir` apps | M | load-bearing (§7 pod trust) |
| P5 | Live container ports through the relay (§7 bonus) — after `feat/a2a-relay` | L → split | load-bearing |

**Smallest useful first slice:** P0 + P1 + P2 — "the agent builds a
self-contained HTML page, I approve, I get a link I can send to someone, it dies
when my session does". P2 alone is useless without P1.

### 7. Bonus — live apps: a container port on the `serve`'s host

**It forces serving model (b):** the bytes are produced live on the user's host,
so visitor traffic must reach the serve — through the relay's outbound link
(no open port). Everything in §1(b) applies, harder.

- **How the serve reaches the port.** Options: (i) the container's IP on its
  engine network — not routable from the host with rootless podman or Docker
  Desktop on macOS, so not portable; (ii) **a port the container publishes on
  the host's loopback** (`-p 127.0.0.1:P:80`) — works everywhere.
  **Recommendation: (ii)**, and the target is never a raw `host:port`: the user
  approves *(engine, container, container port)*; the serve resolves it with
  `inspectContainer` (`packages/docker/src/client.ts:331`) to the published
  loopback port, and **re-resolves on every new connection** (if the container
  stopped and something else took the port, the app goes down instead of
  exposing that something). Refused: host-network containers (their "port" is
  any host service), privileged ones, the engine socket, and a REMOTE engine
  (`tcp://`/`ssh://`, `engine-endpoint.ts:247` — the container is not on the
  serve's host) in v1. `tentacle run --network` (`engine-docker.ts:110`) does
  not change this: the serve still dials the published loopback port.
- **Which containers.** Tentacle-created (`tentacle.managed`, `client.ts:77`)
  vs any container on the host. A label is set by whoever creates the container
  — the agent can `docker run --label tentacle.managed=true` from a shell — so
  a label is NOT a trust signal. Trust comes from the **owner approving each
  exposure through the single broker**, with the prompt naming the container
  (image, name, id, port) as the engine reports it, never as the agent describes
  it. **Recommendation: any local container, owner-approved per exposure, never
  `allow_always`; the workload never chooses what gets exposed.**
- **Protocol scope.** HTTP/1.1 + WebSocket (the browser case) only, routed by
  SNI/Host. Raw TCP has no SNI (needs a port per app on the relay — databases,
  SSH: exactly what must never be public). No raw TCP.
- **Auth — public is far riskier than static.** A live service can be an admin
  panel, a database UI, a dev server with debug endpoints, or a proxy that
  turns into **SSRF/pivot into the user's home or office network**. Options:
  (1) public (as static); (2) **a capability link** (random secret in the URL →
  exchanged for an `HttpOnly` cookie scoped to that app's origin, with the
  secret checked by the serve, not the relay); (3) basic-auth with a generated
  password; (4) **private to the user's paired devices** — no public URL at all:
  the phone opens the container through the EXISTING Noise channel in an
  in-app WebView. **Recommendation: (2) by default, (1) only as an explicit
  per-exposure choice in the prompt, and build (4) FIRST** — it is the likely
  real use ("show me the dev server on my phone"), it needs no domain, no TLS
  work and no abuse policy, and it reuses the relay exactly as built.
- **Bandwidth/latency.** Every visitor request crosses visitor → relay box →
  user's uplink → serve → container: one extra hop of RTT through the relay
  (tens of ms in the EU), throughput bounded by the user's upload and by the
  relay box's link, each visitor connection a relay stream (separate budget
  from the phone's 64, `relay-core.ts:51`) and per-app byte caps counted
  without reading content. Fine for demos and previews, not for real traffic.
- **Lifetime:** up while the session is alive AND the container is running AND
  the serve's relay link is up; any of them down → the relay's offline page.
  Session close/archive or container stop → the exposure is removed (not just
  paused).
- **TLS:** passthrough with the serve terminating (the `feat/a2a-relay`
  design), so a capability cookie and anything visitors type never cross the
  relay in clear — here, unlike static pages, there IS private traffic.
- **Recommendation: a later phase (P5), after `feat/a2a-relay` is built and
  proven; ship the private phone preview (option 4) earlier as its own feat if
  the owner wants the use case sooner.** Owner Q7.

## Implementation

*(empty until the eval is promoted — AGENTS §10)*

## Execution

*(empty until the eval is promoted)*

## Review

*— claude-opus-5-5, 2026-11-26*

**Verdict: GO-with-conditions** for static session apps; **later phase** for
live container ports.

Conditions (each a blocker for going public):
1. A **separate registrable domain** for user content, on the PSL — never
   `apps.tentacle.so`.
2. **Upload + lease** serving (§1 a), one wildcard DNS-01 certificate, random
   ids, no vanity names.
3. **Host-enforced CSP with the network off** (`connect-src`/`form-action`/
   `worker-src 'none'`), content-type allowlist, size/rate/lifetime caps.
4. **Ask every publish through the single broker**, no `allow_always`, secret
   scanner on the bytes, publishing only a `present`ed artifact; pods publish
   only via the laptop (`ProxyAppPublisher`).
5. Abuse contact, report link, takedown + kill switch, terms and privacy note
   live **before** the first public URL.
6. The apps host **not on the box** that serves `tentacle.so`, the relay and a
   third-party business app (own IP or a CDN).

What I could not verify: the DNS provider of `tentacle.so`; the box's traffic
plan; current PSL/Let's Encrypt numbers; the legal reading (DSA category and
exemptions). None changes the verdict; each is a P0 check.

**Sintesi per il proprietario.** Sì, ma: le app statiche si CARICANO su un
nostro host (con un "affitto" rinnovato finché la sessione è viva: chiusa la
sessione o spento il serve per più di 5 minuti → pagina "offline"); su un DOMINIO
SEPARATO (non `tentacle.so`: una sola pagina di phishing farebbe finire in
blacklist il sito, l'install e il relay); rete bloccata dentro le pagine; ogni
pubblicazione la approvi tu, ogni volta. Le porte dei container vivi passano dal
relay e sono molto più rischiose: dopo `feat/a2a-relay`, e prima ancora conviene
l'anteprima PRIVATA sul telefono (nessun URL pubblico).

### Owner questions

1. **Domain:** which separate domain for user content (e.g. `tentacle.page`,
   `tentacle-apps.net`)? — *Recommendation: a short neutral one, on a DNS host
   with an API, submitted to the PSL; never `apps.tentacle.so`.*
2. **Where the apps host runs:** a new small VPS (own IP), object storage + CDN,
   or the current box? — *Recommendation: a new small VPS; not the box with
   `tentacle.so`, the relay and `gestionale.farci.to`.*
3. **Network inside apps:** off (as `present`), or allow an allowlist of origins
   per app? — *Recommendation: off in v1; a per-app allowlist shown in the
   prompt later, if a real app needs it.*
4. **Lifetime:** lease TTL 5 min, hard maximum 7 days (re-approve to extend),
   even for `--session-ttl never` sessions? — *Recommendation: yes, as stated.*
5. **First-visit interstitial** ("published by a tentacle user, not by
   tentacle · Report")? — *Recommendation: yes, from day one; it is the cheapest
   anti-phishing control.*
6. **Accounts:** anonymous key-owned apps (no accounts, like the relay) with rate
   limits + kill switch? — *Recommendation: yes; gate on a registered relay id or
   proof-of-work only if abuse shows up.*
7. **Live container ports:** later phase after `feat/a2a-relay`, capability link
   by default, public only per explicit choice — and a PRIVATE phone preview of a
   container port (over the existing Noise channel) as an earlier separate feat?
   — *Recommendation: yes to both; the private preview first, it carries none of
   the public-hosting risk.*
8. **Multi-file apps:** v1 = a single self-contained HTML artifact, directories in
   P4? — *Recommendation: yes; the model already writes self-contained pages for
   `present`.*

### Owner answers (2026-11-26 ~10:00, one at a time)

1. **Domain:** a SEPARATE registrable domain, short and neutral (e.g. `tentacle.page` / `tentacle-apps.net`), on a DNS host with an API, submitted to the Public Suffix List — never `apps.tentacle.so` (as recommended). Next: check availability and propose the name.
2. **Apps host:** a NEW dedicated small server with its own IP (as recommended).
3. **Network inside apps:** OFF in v1 (CSP `connect-src`/`form-action`/`worker-src` as `present`); a per-app allowlist only later, if a real app needs it (as recommended).
4. **Lifetime:** **tied to the session only — NO hard maximum** (NOT the recommendation of 5-min lease + 7-day cap). The lease stays (the app goes down a few minutes after the session ends / the serve stops renewing), but a live session keeps its app up indefinitely.
5. **First-visit warning page** «published by a tentacle user · Report»: yes, from day one (as recommended).
6. **Accounts:** none — apps owned by the serve's key, with rate/size limits and the kill switch; stricter gating only if abuse appears (as recommended).
7. **Live container ports (bonus):** a later phase, after `feat/a2a-relay`, reachable by a SECRET link by default, never public; the private phone preview over the existing Noise channel comes first (as recommended).
8. **Files:** v1 publishes ONE self-contained HTML (already shown with `present`); directories come in phase 4 with pods (as recommended).

*— claude-opus-5-5 (orchestrator, recording the owner's answers), 2026-11-26*

**Owner, 2026-11-26 ~10:05:** «fino a che non compro l'altro dominio usiamo tentacle.so» — INTERIM: apps live under `tentacle.so` (e.g. `<id>.apps.tentacle.so`, wildcard cert via DNS-01) until the separate domain is bought. Consequences for the plan: the apps domain is a CONFIG value of the apps host + the publish tool (switching = config + DNS, no code); every other condition stays (first-visit warning, CSP with network off, caps, kill switch, every publish asked through the broker, secret scan); the apps host must set no cookies and never share an origin with `tentacle.so` itself. Known interim risk (stated once, owner's call): an abusive app can get `tentacle.so` listed by Safe Browsing until the move.

*— claude-opus-5-5 (orchestrator), 2026-11-26*

**Owner, 2026-11-26 ~10:10:** «si usa lo stesso server di tentacle per ora» — INTERIM: the apps host runs on the current tentacle.so box (Caddy) until a dedicated server exists; it must be a separate process/site block with its own limits (bandwidth, storage, rate) so moving it later is a deploy, not a rewrite. **PROMOTED to feat** (umbrella; this doc): P1 `feat/session-apps-host` (the apps-host service) → P2 `feat/session-apps-publish` (publish/unpublish tools, worker + serve, broker-gated). P0 (DNS wildcard `*.apps.tentacle.so` + DNS-01 cert, legal pages on the site) needs the owner at deploy time. Deploys and DNS changes are done only with the owner's OK.

*— claude-opus-5-5 (orchestrator), 2026-11-26*
