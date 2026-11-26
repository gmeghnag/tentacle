# feat/session-apps-publish — `app_publish` / `app_unpublish`: the agent publishes a presented page, the owner approves every time

> **Status:** implementation (APPROVED — the owner delegated the remaining details; see *Orchestrator decisions*)
> **Branch:** `feat/session-apps-publish`
> **Type:** feat · **Size:** L (six slices on one branch, below; ~35 files across protocol → core → agent → daemon → tools → cli → client → tui → mobile) · **Blast:** load-bearing (single broker, a new effect that leaves the user's host — AGENTS §7 identity —, the `serve` sidecar format, a protocol bump) · **Suited:** Opus plans (this doc) → Sonnet executes slice by slice → **mandatory fresh-context Opus review** red-teaming the single-broker, identity and persistence invariants
> **Changelog:** `changelog.d/session-apps-publish.added.md`

Umbrella: `docs/feat/session-apps.md` (P2 of 6). P1, the host, is merged
(`docs/feat/session-apps-host.md`, merge `fab2ca91`); this task is its only client.

## Context

*— claude-opus-5-5, 2026-11-26*

**Why.** The owner approved session apps (`docs/feat/session-apps.md:460-477`): the
agent builds a self-contained HTML page, the owner approves, a public URL
`<id>.<apps domain>` lives as long as the session. P1 built the host that keeps and
serves such a page (`apps/apps-host`, contract `packages/protocol/src/apps-host.ts`).
Nothing in tentacle can publish to it yet: no tool, no key, no lease loop, no ask,
no UI. P1 alone is useless (`session-apps.md:325-327`).

**Binding constraints (owner answers, `session-apps.md:460-477`):**
- **A1 domain:** the apps domain is CONFIG; interim `apps.tentacle.so` (`:473`), a
  separate registrable domain later — switching is config + DNS, no code.
- **A3 network off** inside apps (`:464`) — enforced by the host's CSP; the
  publisher does not need to rewrite anything (`session-apps-host.md:277-286`).
- **A4 lifetime tied to the session, NO maximum** (`:465`): the lease stays (5 min,
  renewed every 60 s), a live session keeps its app up indefinitely.
- **A5 first-visit warning** — the host's (`session-apps-host.md:185`, D5).
- **A6 no accounts:** apps are owned by **the serve's key** (`:467`).
- **A8 one self-contained HTML, already shown with `present`** (`:469`); directories
  and pods come in P4.
- **Umbrella conditions** (`session-apps.md:404-417`, condition 4): every publish
  asked through the **single broker**, **no `allow_always`**, a **secret scan** of
  the bytes, only a `present`ed artifact, a pod publishes only through the laptop.
- **Deploy and DNS only with the owner** (`:477`): this task deploys nothing.

**Repro** (2026-11-26, worktree `HEAD fab2ca91`, Bun 1.4.3; scripts in
`.tentacle/tmp/session-apps-publish/`, pasted because that folder is gitignored).

1. The capability is missing — the only mentions of a publisher are the P1
   contract and its test:

```
$ rg -l 'app_publish|app_unpublish|AppPublisher|appsSigningPayload|Ed25519' packages
packages/protocol/test/apps-host.test.ts
packages/protocol/src/apps-host.ts
```

2. The ask machinery: an existing owner-only kind (`agent_add`) is once-only, never
auto-approved, never external, and survives the wire round trip; **a publish ask
WITHOUT its own kind would be auto-approvable and would offer "always"** — the
red the new kind turns green:

```ts
// ask.ts
import { autoApproves, externalMayAnswer, onceOnlyAsk } from "../../../packages/core/src/index.ts";
import { toPermissionRequest } from "../../../packages/client/src/permission-router.ts";
import { permissionOptions } from "../../../packages/daemon/src/permission-map.ts";
const req = { kind: "agent_add" as const, tool: "a2a_add_agent", level: "ask" as const, title: "t", input: {} };
console.log("agent_add: autoApproves", autoApproves(req), "onceOnly", onceOnlyAsk(req), "external", externalMayAnswer(req.kind));
console.log("agent_add options", permissionOptions(req).map((o) => o.kind).join(","));
const wire = { type: "permission_request", requestId: "r", toolCallId: "c", tool: "a2a_add_agent", title: "t", options: permissionOptions(req) };
console.log("client rebuilds kind", toPermissionRequest(wire as never).kind);
const plain = { tool: "app_publish", level: "ask" as const, title: "t", input: {} };
console.log("kind-less app_publish ask: autoApproves", autoApproves(plain), "options", permissionOptions(plain).map((o) => o.kind).join(","));
```
```
$ bun .tentacle/tmp/session-apps-publish/ask.ts
agent_add: autoApproves false onceOnly true external false
agent_add options allow_once,reject_once
client rebuilds kind agent_add
kind-less app_publish ask: autoApproves true options allow_once,allow_always,reject_once
```

3. The publisher key can live in a plain file: Bun's WebCrypto exports an Ed25519
private key as JWK, re-imports it, and the signature verifies under the raw
32-byte public key the host expects (`APPS_KEY_BYTES`, `apps-host.ts:38`):

```ts
// key.ts
const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const priv = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const msg = new TextEncoder().encode("tentacle-apps/1\nPOST\napps.tentacle.so\n/v1/apps");
const sig = await crypto.subtle.sign("Ed25519", priv, msg);
const pub = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
console.log("jwk", jwk.kty, jwk.crv, typeof jwk.d, typeof jwk.x, "pub", raw.length, "verify", await crypto.subtle.verify("Ed25519", pub, sig, msg));
```
```
$ bun .tentacle/tmp/session-apps-publish/key.ts
jwk OKP Ed25519 string string pub 32 verify true
```

## Implementation

*— claude-opus-5-5, 2026-11-26* · **APPROVED** (the owner delegated the remaining details to the orchestrator, 2026-11-26; each choice is under *Orchestrator decisions*)

### Load-bearing assumption

**A publish can be gated by an ask that reaches a human on every surface and that
nothing else can answer: not auto-accept (the session's, a client's, the daemon's),
not an "always" rule, not an external A2A caller.** Every other safety property —
secret scan, artifact-only input, the lease — is shown IN that ask or happens after
it; if the ask can be waved through, the rest is decoration.

Proved by the code and the probe (Repro 2):
- A tool may raise its OWN ask with its own kind instead of the generic tool ask:
  `a2a_add_agent` is `permission: "none"` and calls the session's broker itself
  with `kind: "agent_add"` (`packages/tools/src/a2a-add-agent.ts:73-104`), wired to
  `permissions.request` — the ONE broker (`packages/cli/src/wiring.ts:1199`).
- A kind is excluded from every auto-answer by ONE function, `autoApproves`
  (`packages/core/src/permission.ts:394-410`), used by the daemon
  (`packages/daemon/src/hosted-session.ts:1898-1913`), the CLI relay policy
  (`packages/cli/src/relay-policy.ts:64-65`), the TUI
  (`packages/tui/src/permission-ui.ts:544`, `:595`) and the phone
  (`apps/mobile/src/permission-sheet.ts:545`).
- `onceOnlyAsk` (`permission.ts:435-439`) makes the daemon offer only
  `allow_once`/`reject_once` (`packages/daemon/src/permission-map.ts:33-38`); an
  option not offered is `InvalidParams` and the request STAYS pending
  (`packages/protocol/src/permission.ts:15-19`) — so even a client that draws an
  "always" button cannot create a rule.
- External callers: `EXTERNAL_ANSWER` is exhaustive over kinds and does not
  compile until a new kind is classified (`permission.ts:120-143`); `owner-only`
  → `externalMayAnswer` false (`:146-148`), applied by the A2A adapter
  (`packages/daemon/src/external/asks.ts:70-90`).
- The kind crosses the wire only by the TOOL NAME: a client rebuilds it from
  `update.tool` (`packages/client/src/permission-router.ts:155-163`,
  `external/asks.ts:71-80`). An OLDER client does not know the name and treats it
  as a plain tool ask, which its auto-accept WOULD answer (Repro 2, last line) —
  exactly the hazard that moved `PROTOCOL_VERSION` for `workflow_approve` (25),
  `browser_action` (26) and `a2a_add_agent` (28)
  (`packages/protocol/src/version.ts:32-48`, `:68-75`). So this task writes a
  `protocol.d/` note and a mixed pair fails at `initialize`.

### Preconditions

Verified in the source:

- **The host contract (P1).** Signed requests: headers `Tentacle-Key/-Date/-Nonce/-Signature`
  (`packages/protocol/src/apps-host.ts:26-40`), payload `appsSigningPayload`
  (`:47-64`, the domain is signed); answers `AppsLeaseResultSchema { id, url,
  leaseExpiresAt, leaseMs, renewAfterMs }` (`:67-75`) and `AppsErrorSchema` with
  `reason` (operator's statement of reasons) and `serverTime` (`:77-111`). Routes:
  `POST /v1/apps` create, `PUT /v1/apps/<id>` update **or revive an expired
  tombstone at the same URL**, `POST /v1/apps/<id>/lease` renew, `DELETE` →
  `deleted` (`docs/feat/session-apps-host.md:233-246`, `apps/apps-host/src/routes.ts:19-46`);
  status per code `routes.ts:49-70`. Renew has **no maximum** and works under the
  kill switch (`session-apps-host.md:318-320`). Replay is refused, never
  idempotent: every retry signs anew; a lost create is an orphan that lapses with
  its lease (`:183`, D3). Defaults: 10 MiB, 5 live apps per key
  (`apps/apps-host/src/limits.ts:15-16`), lease 5 min (`:45`), renew 60 s. After a
  host restart a publisher with a slow clock gets `409 replay` for a few seconds
  (`docs/ops/apps-host-deploy.md` §8).
- **Artifacts are the session's, by sha.** `present` stores an immutable snapshot
  (`packages/tools/src/present.ts:1-12`); the store lists metas
  (`packages/daemon/src/artifact-store.ts:205-207`) and holds bytes by sha256
  (`:128-129`), evictable on memory hosts (`:11-15`, `:155-157`); a resumed worker
  session is seeded from the laptop's copy (`:52-66`). On `serve` the daemon's
  store is **memory only** — its disk copy is a later slice
  (`packages/daemon/src/session-host.ts:1679-1685`, `docs/feat/model-artifacts.md:1213`).
  `MAX_ARTIFACT_BYTES` is 20 MiB (`packages/protocol/src/artifact.ts:45`) — above
  the host's 10 MiB, so the publisher pre-checks.
- **The per-session, host-only link is an existing shape: schedules.** A lazy
  link in `AgentContext` (`session-host.ts:172-179`), present only where the host
  passes the daemon-wide option (`:434-440`; `serve` `packages/cli/src/serve.ts:865-866`,
  worker `packages/cli/src/worker.ts:196`), re-handed on a settings rebuild
  (`session-host.ts:1806-1809`) and at create (`:1707-1708`); the factory
  registers the tools only when it is present (`wiring.ts:750`, `:1444-1447`); the
  pod factory `tunnelledAgent` never passes it (`serve.ts:261-270`, `:1296`).
- **The session's single END** is `HostedSession.close` — it covers close,
  archive, the reaper, the detached cap and delete (`hosted-session.ts:5396`,
  comment `:5443-5444`). `archive` captures state before AND after the close and
  keeps the after-close fields except log/turn (`:5476-5496`). A `serve` stop
  does NOT close sessions (it stops the persister, `serve.ts:669-681`); they are
  reloaded at the next start (AGENTS §7).
- **Persistence on `serve`.** `persistedState` writes the schedules table only
  when non-empty (`hosted-session.ts:2171`); a change calls `this.persist()`
  (`:2036`, used by `scheduleChanged` `:4731-4736`). The sidecar is versioned on
  its own; a field an older build would silently DROP gets a version written only
  when it is present (`packages/daemon/src/daemon-state-file.ts:66-90`,
  `sidecarOf` `:145-178`, parse `:408-428`). Record type
  `packages/daemon/src/persisted-session.ts:115`, `:176`.
- **A display list with a user action is an existing shape: schedules.** Update
  `SchedulesUpdateSchema` (`packages/protocol/src/updates.ts:432-444`), class
  `display` (`:593`); snapshot field (`packages/protocol/src/session.ts:1572-1578`);
  the user's delete `session/schedule_delete` (`session.ts:1501-1525`,
  `packages/protocol/src/methods.ts:185`, `:376`, `packages/daemon/src/connection.ts:526-528`);
  client mapping (`packages/client/src/mapping.ts:382`), feeds gated on the
  daemon trust bit `daemonWakes` — a pod's list is dropped
  (`packages/client/src/remote-client.ts:4259-4265`, `:4455-4461`), a refusal
  without sending to an untrusted daemon (`packages/client/src/remote-session.ts:1536-1550`);
  `daemonWakes` is set by the worker and `connect` only
  (`packages/cli/src/local-runtime.ts:1745`, `packages/cli/src/connect.ts:301`).
  TUI: `/schedule` panel (`packages/tui/src/commands/schedule.ts:1-31`), status
  segment (`packages/tui/src/status-view.ts:104-116`), quit warning
  (`packages/tui/src/commands.ts:296-299`). Phone: the session info sheet's
  `schedulesSection` (`apps/mobile/src/session-info.ts:802`), its feed and delete
  (`apps/mobile/src/session-info-controller.ts:159`, `:313-440`, `:772`).
- **Sub-agents** drop session-level tools by name in two places
  (`packages/agent/src/subagent.ts:524`, `:781`).
- **A secret rule table exists**: `DEFAULT_REDACT_RULES` (private keys, JWT,
  `gh*_`, `xox*-`, `AKIA…`, `AIza…`, `sk-…`, bearer, URL credentials, `KEY=value`
  assignments; `packages/agent/src/redact.ts:21-57`); `@tentacle/daemon` depends on
  `@tentacle/agent` (its `package.json`), `@tentacle/tools` on core only.
- **A private key file is an existing shape**: `loadOrCreateIdentity` — 0700 dir,
  0600 file, `link` so two creators end with ONE key, an unreadable file is
  refused, never replaced (`packages/daemon/src/device-store.ts:340-380`, `:218-236`).
  That identity is an X25519 Noise key, so it is **not** reusable as an Ed25519
  signing key.
- **Backoff pattern**: the relay link's capped exponential with a never-zero
  jitter (`packages/daemon/src/relay-link-policy.ts:123-126`).
- **The deploy README exists**: P1 wrote `docs/ops/apps-host-deploy.md` (D16) with
  the DNS-01 Caddy block (`apps/apps-host/deploy/Caddyfile.apps:12-31`, runbook §4),
  the process (§2–3) and the limits (§7).

### Design

#### Orchestrator decisions

The owner delegated the details; each is the recommended option with the one reason that decides it.

| # | Decision | Chosen | Why (the alternative, rejected) |
|---|---|---|---|
| D1 | Runtimes | **Worker and `serve`** (so `connect` too: the serve publishes). A **pod daemon is not offered the tools**: `tunnelledAgent` never passes the link. The laptop-side `ProxyAppPublisher` (reverse RPC, laptop re-checks + asks + uploads) is **P4**, with directories (owner A8, `session-apps.md:322`). | "A pod publishes only through the laptop" holds trivially — in P2 it cannot publish at all. A pod proxy is its own load-bearing seam (the laptop fetching pod-supplied bytes, its own gate); bundling it makes this L task bigger with no user asking for it yet. |
| D2 | Publisher key | **One Ed25519 key per config dir**, `<configDir>/apps/publisher.json` (JWK, 0600, dir 0700), created at the **first approved publish**, shared by every session of that host (worker and serve on one machine included). Unreadable/malformed → refused, never replaced. | Owner A6 "owned by the serve's key". A key per session (umbrella §4) would dodge the host's per-key cap (5) and burn the per-IP new-key budget (10/day). Lazy creation: a host that never publishes never has a key. |
| D3 | The ask | A new `PermissionKind` **`app_publish`** (wire tool `app_publish`), raised by the tool itself (`permission: "none"`, like `a2a_add_agent`); **once-only** (allow once / deny), never auto-accepted, `owner-only` for external callers. **Every create and every content update asks.** No ask: renew, the automatic revive of the SAME sha (D4), unpublish. | Each version is a new public disclosure (`session-apps.md:243-247`); the existing kind machinery gives all four guarantees by adding one name to four sets (Load-bearing assumption). |
| D4 | Lease lapse | When a renew answers `410 expired` (laptop slept, serve or host down > 5 min), the publisher **revives the same URL with the SAME bytes** (`PUT`, verified sha) without a new ask, if it still holds them; otherwise the app is `down` with "publish again". | Owner A4: the approval is "up while this session lives"; a lapse is a transport interruption, the content and URL are the ones approved. Different bytes always ask. |
| D5 | Secret scan | Reuse `DEFAULT_REDACT_RULES` through a new pure `findSecrets(text, rules)` → `{ rule, line }[]` (cap 20). Findings appear **in the ask** (rule name + line, **never the value**) and change its title to «Publish … despite N possible secrets?»; **Allow once = the explicit override**. | One rule table (no drift with output redaction). Blocking outright makes a false positive (`token=` in a demo) unpublishable; the ask already IS the explicit human decision. The value stays out of a prompt that travels to phones. |
| D6 | Tool input | `app_publish { artifact: string, version?: number }` — an artifact **of this session's store**, html only (`text/html`), ≤ 10 MiB, valid UTF-8. Never a path, never content. One app per artifact id per session: an artifact id already published → **update** (same URL, asks); else **create**. `app_unpublish { app: string }` — only this session's apps. | Owner A8 + condition 4: only what the user was SHOWN (its card is in the transcript). "Same artifact → same URL" matches `present`'s own versioning, so the model needs no app-id bookkeeping. |
| D7 | Protocol | Additive: display update **`apps`** (the FULL list), snapshot field **`apps`**, method **`session/app_unpublish`**. Plus the wire ask tool `app_publish` → **`protocol.d/session-apps-publish.md`** (bump at merge). | The schedules shape, end to end. The note is not optional: an older client's auto-accept would answer the ask (Repro 2; precedent `version.ts:68-75`). |
| D8 | Persistence | `serve`: the session's app **records** (id, url, artifact id/version/sha, title, publishedAt) in the sidecar, written only when non-empty, under a **new sidecar version 5** (`DAEMON_STATE_VERSION_APPS`), so an older build refuses that ONE session loudly instead of dropping its apps and leaving them unrenewed. Worker: memory only. The laptop log: nothing (apps are not conversation, AGENTS §7). The key is a separate file (D2), never in a sidecar. | The schedules precedent (`daemon-state-file.ts:70-83`) and AGENTS §7 "never half-loads". `pinnedAt` chose "ignore" because a lost pin is harmless; a lost app record is a public page no one renews or can stop from this session. |
| D9 | Lifecycle | Up while the session is open on a process that renews. `HostedSession.close` (every end) **ends every app**: rows dropped synchronously, `DELETE`s fired best effort (10 s timeout, unref'd), never awaited by `close`; the `session/close` handler then awaits them **≤ 3 s** before replying, so a quitting TUI gives them their chance. `serve` stop: timers stopped, no `DELETE`; restart → the reloaded session renews (revives per D4). `/clear`: the source keeps its apps; the fork has none. | Owner A4; a `serve` restart is not a session end (AGENTS §7). A lost `DELETE` converges by the lease: the page goes offline ≤ 5 min later. |
| D10 | UI | URL in the tool result text (every surface renders it today). **TUI:** `/apps` panel (title, URL, state, reason; `s` stops), status segment («2 apps» / «app down»), worker quit warning «quitting takes 1 live app offline». **Phone:** an «Apps» section in the session info sheet (title, URL, state + reason, Copy, Stop). The transcript «Live» card and the hub badge stay **P3**. | Reuses the schedules surfaces on both (no new visual pattern → no mockup question for the owner); phone parity for serve sessions (owner, memory "phone/mac parity"). |
| D11 | Config | `apps.enabled` (default **false**) and `apps.domain` (default `apps.tentacle.so`), host config only. | Nothing is deployed: a default-on tool would fail every call. Flipping the default after the owner's smoke test (runbook §12) is a one-line follow-up. |
| D12 | State on the wire | `state` is a **free string** (`up` · `renewing` · `down` · `removed`) narrowed by a client function `appStateOf` (unknown → shown as `unknown`, never as `up`); `reason` free text ≤ 500. | A display update must survive a newer daemon's new state (the free-`kind` rule, `artifact.ts:90`). |
| D13 | Size cap | Export `APPS_MAX_APP_BYTES_DEFAULT = 10 MiB` from `apps-host.ts`; the host's `limits.ts` default uses it; the publisher refuses above it **before asking**. A host configured lower still answers `413 too_large`, mapped. | One number for both ends; never ask the owner about a page the host will refuse. |
| D14 | Upload vs the turn | Once approved, the upload runs on the **session's** abort signal, not the call's: a turn cancelled mid-upload still records the app (the owner approved it); a session closed mid-create `DELETE`s the new id as soon as the create answers. | No orphan state on either side; an app never outlives its session by more than the bounded `DELETE`. |
| D15 | Deploy README | **Extend `docs/ops/apps-host-deploy.md`** with §12 «Turning publishing on» (config keys, where the key lives, the smoke from a real session, rotation, the per-key cap shared by the host's sessions); the DNS-01 Caddy block, process and limits stay where P1 put them. | One runbook (P1 D16); a second copy of the Caddy block would drift. |

#### Shape

```
model ──app_publish{artifact}──► tool (tools pkg, permission "none")
                                   │ link.prepare  → meta, bytes, sha, findings, new|update(url)   (daemon: SessionApps)
                                   │ ask(kind app_publish) ──► the session's ONE broker ──► human (TUI / phone)
                                   │ link.publish(prepared) → re-hash = meta.sha → signed POST|PUT
                                   ▼
                       SessionApps (per session) ── rows ──► HostedSession: emit `apps`, persist() (serve)
                         │ lease timer per app (renewAfterMs, backoff on failure)
                         └─ AppsService (per daemon): key file, AppsClient(fetch, clock offset), id→session map
                                   │ HTTPS, Ed25519-signed
                                   ▼
                       apps-host (P1)  <id>.apps.tentacle.so
```

#### Core types (`packages/core/src/apps.ts`, new; React-free, no I/O)

- `APP_PUBLISH_TOOL = "app_publish"`, `APP_UNPUBLISH_TOOL = "app_unpublish"` (the
  subagent filter and the client map import them).
- `AppRow { app, url, artifactId, version, title, state, reason?, since, publishedAt }`
  — `since`: daemon ms of the last state change (display only).
- `PreparedPublish { kind: "create" | "update", app?, url?, meta: ArtifactMeta,
  bytes: Uint8Array, findings: readonly SecretFinding[] }`.
- `AppsLink { prepare(input): Promise<PreparedPublish | { ok: false, reason }>;
  publish(prepared): Promise<{ ok: true, row } | { ok: false, reason }>;
  unpublish(app): Promise<{ ok: boolean, reason? }>; list(): readonly AppRow[] }`.
- `PermissionRequest.kind` gains `"app_publish"` (`permission.ts:65-72`);
  `EXTERNAL_ANSWER.app_publish = "owner-only"` (`:131-143`); `autoApproves`
  excludes it (`:394-410`); `onceOnlyAsk` includes it (`:435-439`).

#### The tool (`packages/tools/src/app-publish.ts`, new)

`createAppPublishTool({ link: () => AppsLink | null, ask: PermissionRequester })`:
1. No link → `isError` "publishing apps is not available in this session".
2. `link.prepare({ artifact, version })` — refusals come back as text, nothing
   asked: unknown artifact / version, not html, over 10 MiB, bytes evicted
   («present it again»), the same sha already live in this session («already
   live at <url>», no ask, no upload).
3. `ask(appPublishAsk(prepared))` — a PURE builder (unit-tested) giving
   `{ kind: "app_publish", tool: APP_PUBLISH_TOOL, level: "ask", title, detail,
   input: { artifact, version, sha256 } }`. Title: «Publish "<title>" as a public
   web page?» / «Update the public page <url>?» / «… despite N possible
   secrets?». Detail lines: the URL (create: «a new random address under
   https://*.<domain>»), artifact id vN, size, sha256 first 12, «Anyone with the
   link can open it until this session ends», «Network is blocked inside the
   page», then each finding «possible <rule> on line <n>». Model text flattened
   like `a2a-add-agent.ts:51-57`. `ctx.toolCallId` + `origin: "call"` + `ctx.signal`
   as `a2a-add-agent.ts:99-103`.
4. Denied → `isError` «not published: the user declined» (+ their reply). No
   requester → `isError` with the reason.
5. `link.publish(prepared)` → text «Published "<title>" at <url> — live while this
   session is open» / the mapped host error.

`concurrency: [{ mode: "write", resource: "apps" }]` (two publishes of one round
serialize). `createAppUnpublishTool(link)`: `permission: "none"` (it only reduces
exposure), only an app of this session, same resource key.

#### Daemon

- **`apps-key.ts`** — `loadOrCreateAppsKey(configDir)` → `{ publicKey: string (b64url, 43), sign(bytes) }`
  on the `device-store.ts:340-380` pattern (link-race, 0600/0700, refuse unreadable).
- **`apps-client.ts`** — `AppsClient({ domain, baseUrl?, fetch, now, random, key })`:
  `create(bytes)`, `update(id, bytes)`, `renew(id)`, `remove(id)`. Signs with
  `appsSigningPayload`, sets `host: domain` (tests point `baseUrl` at a loopback
  host); `Date` = `now() + offset`, the offset learned from a `clock_skew`'s
  `serverTime` (one immediate re-sign, never a loop). Parses with the P1 schemas;
  checks `id` with `isAppId` and `url === \`https://${id}.${domain}/\`` (else
  treated as `internal`, and a created id is `DELETE`d). Timeouts: 30 s upload,
  10 s otherwise. Outcome: `{ ok: true, lease } | { ok: false, code, message,
  retryAfterMs?, reason?, transient }` where `transient` = network error, timeout,
  `replay`, `busy`, `rate_limited`, `internal`, `clock_skew`.
- **`apps-lease.ts`** — PURE state machine (no timers, no I/O):
  `leaseStep(row, event, now)` → `{ row, action }`; events `renewed(lease, sentAt)`,
  `failed(outcome)`, `tick`; actions `renewAt(ms)`, `revive`, `stop`. Rules:
  renewed → `up`, next at `sentAt + renewAfterMs` (the LOCAL send time: never
  compare host and daemon clocks); transient failure → `renewing`, retry with the
  relay backoff (1 s … 60 s, never 0), and once `now > lastOkSentAt + leaseMs` →
  `down` («offline: the host has not confirmed for N min») while still retrying;
  `expired` → `revive` (D4) or `down` «publish again» when the bytes are gone;
  `taken_down` / `blocked` → `removed` + the operator's `reason`, `stop`;
  `deleted` / `not_found` / `forbidden` → `removed` «no longer on the host», `stop`.
- **`session-apps.ts`** — `AppsService` (per daemon: config, client, key loaded
  lazily, `owners: Map<appId, sessionId>`, `stop()` for `serve` stop) and
  `SessionApps` (per session): rows, one timer per app via the injected
  `setTimeout`/`clearTimeout` (unref'd default, as `hosted-session.ts:560-567`),
  ONE in-flight operation per app (a Stop aborts a running renew first), an
  `AbortController` for the session's life (D14). `prepare` reads the
  `ArtifactStore` (new method `bytesOf(sha256)` beside `read`, same eviction/seed
  path) and runs `findSecrets`; `publish` re-hashes and refuses a mismatch;
  `restore(records)` arms a renew at once for each; `endAll()` (D9) returns the
  `DELETE` promises. Changes go to `onChange(rows)`. Logs (ids, codes — never
  bytes, keys, signatures) go to the daemon's log sink, never stdout (AGENTS §7
  terminal rule: the worker shares Ink's terminal).
- **`hosted-session.ts`** — owns `apps?: SessionApps`; `appsLink()` beside
  `scheduleLink` (`:4583`), `null` when closed; on change: `persist()` + emit
  `{ type: "apps", apps }`; `persistedState` adds `apps` records when non-empty
  (beside `:2171`); the snapshot's first page carries `apps` (beside `:2621`);
  `close()` calls `this.apps?.endAll()` beside the other disposals (`:5443-5460`);
  `unpublishApp(app)` for the RPC. Kept to wiring only — the logic is in
  `session-apps.ts` / `apps-lease.ts` (AGENTS §7 "logic lives in pure modules").
- **`session-host.ts`** — `SessionHostOptions.apps?: AppsService` (doc like `:434-440`),
  `AgentContext.apps?: () => AppsLink | null` (like `:172-179`), passed at create
  (`:1707-1708`), on rebuild (`:1806-1809`) and to the `HostedSession` constructor
  (beside `this.opts.schedules`, `:1750`), with `restored.apps`.
- **`persisted-session.ts` / `daemon-state-file.ts`** — `apps?: readonly AppRecord[]`;
  `DAEMON_STATE_VERSION_APPS = 5` written exactly when `apps` is non-empty, added to
  `DAEMON_STATE_VERSIONS`; a v<5 file carrying `apps` is refused (as `:408-418`);
  a malformed `apps` refuses the file. On load, a record whose app id is already
  owned by another session of this daemon (a copied sidecar) is dropped with a log
  line — one owner per id.
- **`connection.ts`** — `Method.AppUnpublish` (as `:526-528`): synchronous
  validation, the `DELETE` awaited by the handler only (the peer is never
  serialized, AGENTS §7). `Method.Close` (`:402-403`): after the synchronous close,
  `await Promise.race([apps drained, 3 s])` before replying.
- **`external/asks.ts`** — `askOf` maps `APP_PUBLISH_TOOL` → `app_publish` (`:70-80`).

#### Agent

- `redact.ts`: `findSecrets(text, rules = DEFAULT_REDACT_RULES, max = 20)` — pure;
  rule name + 1-based line; never returns the matched value.
- `subagent.ts:524` and `:781`: drop `APP_PUBLISH_TOOL` / `APP_UNPUBLISH_TOOL`
  (the app is the SESSION's; a child's output is its report).

#### CLI and config

- `config`: `apps.enabled` (bool, default false), `apps.domain` (hostname,
  default `apps.tentacle.so`) — schema, resolve, load, defaults, key-docs, profile
  (as `workloadShell.tool`, `packages/config/src/schema.ts:558`, `resolve.ts:745-747`).
- `wiring.ts`: `BuildAgentOptions.apps?` (doc like `:750`), registration beside
  `:1444` with `ask: (req, opts) => permissions.request(req, opts)` (the ONE
  broker, as `:1199`).
- `serve.ts` (`:255-277`, `:865`) and `worker.ts` (`:117-130`, `:196`): build
  ONE `AppsService` when `config.apps.enabled`, pass it as `SessionHostOptions.apps`
  and forward `ctx.apps`; `serve`'s stop (`:669-681`) calls `apps.stop()`.
  `tunnelledAgent` (`:1296`) never passes it — pinned by a test.

#### Client, TUI, phone

- `permission-router.ts:163`: `update.tool === APP_PUBLISH_TOOL → kind "app_publish"`.
- `mapping.ts:382`: `apps` is session-level, not turn-scoped.
- `remote-client.ts`: `appsChanged` feed from the live frame and the snapshot,
  **dropped unless `daemonWakes`** (`:4259-4265`, `:4455-4461` pattern) — a pod's
  list is a pod-supplied claim; `remote-session.ts`: `onApps`, `apps`,
  `unpublishApp(app)` that refuses locally without sending when untrusted
  (`:1536-1550` pattern).
- TUI: `apps-view.ts` (PURE: rows → panel lines, status label, quit text,
  `appStateOf`), `panels/apps.ts`, `commands/apps.ts` (`/apps`, registered in
  `commands/registry.ts`), status segment (`status-view.ts:104-116`), quit warning
  (`commands.ts:296-299`), `permission-ui.ts:290` options for `app_publish`
  («Publish once» / «No» / reply).
- Phone: `session-info.ts` `appsSection(facts)` (PURE, beside `:802`; `SectionId`
  `:194` gains `apps`), `session-info-controller.ts` feed + `stopApp` (as
  `:313-440`, `:772`; `InfoSection` `:159`), `screens/SessionInfoSheet.tsx`
  renders it (Copy uses the existing clipboard path of the artifacts section),
  `permission-sheet.ts:275` labels for `app_publish`.

### Files

In dependency order, as six slices (each green on its narrow tests before the next):

**S1 — contract and kind**
1. `packages/protocol/src/apps-host.ts` — `APPS_MAX_APP_BYTES_DEFAULT`; `apps/apps-host/src/limits.ts:15` uses it.
2. `packages/protocol/src/session.ts` — `AppRowSchema`, `AppUnpublishParams/ResultSchema`, `SnapshotResultSchema.apps?` (`:1555`).
3. `packages/protocol/src/updates.ts` — `AppsUpdateSchema`, union member, `UPDATE_CLASS.apps = "display"`.
4. `packages/protocol/src/methods.ts` — `AppUnpublish: "session/app_unpublish"` + registry entry.
5. `packages/protocol/schema/protocol.json` — `bun run schema:export` (the merge regenerates it anyway).
6. `protocol.d/session-apps-publish.md` — the note (text below).
7. `packages/core/src/apps.ts` (new) + `packages/core/src/permission.ts` + `packages/core/src/index.ts`.
8. `packages/agent/src/redact.ts` (`findSecrets`), `packages/agent/src/subagent.ts`.
9. `packages/client/src/permission-router.ts`, `packages/daemon/src/external/asks.ts`.

**S2 — daemon**
10. `packages/daemon/src/apps-key.ts`, `apps-client.ts`, `apps-lease.ts`, `session-apps.ts` (new).
11. `packages/daemon/src/artifact-store.ts` — `bytesOf(sha256)`.
12. `packages/daemon/src/hosted-session.ts`, `session-host.ts`, `persisted-session.ts`, `daemon-state-file.ts`, `connection.ts`, `index.ts`.

**S3 — tools, config, cli**
13. `packages/tools/src/app-publish.ts` (new), `packages/tools/src/index.ts`.
14. `packages/config/src/{schema,resolve,load,defaults,key-docs,profile}.ts`.
15. `packages/cli/src/wiring.ts`, `serve.ts`, `worker.ts`.

**S4 — client + TUI**
16. `packages/client/src/mapping.ts`, `remote-client.ts`, `remote-session.ts`.
17. `packages/tui/src/apps-view.ts`, `panels/apps.ts`, `commands/apps.ts` (new); `commands/registry.ts`, `panel.ts`, `status-view.ts`, `commands.ts`, `permission-ui.ts`, `useSessionLink.ts` / `App.tsx` (the feed ref, as `schedulesRef`).

**S5 — phone**
18. `apps/mobile/src/session-info.ts`, `session-info-controller.ts`, `screens/SessionInfoSheet.tsx`, `permission-sheet.ts`.

**S6 — docs**
19. `docs/ops/apps-host-deploy.md` — §12 «Turning publishing on» (D15).
20. `changelog.d/session-apps-publish.added.md`.
21. This doc's Execution.

`protocol.d/session-apps-publish.md` (one paragraph, becomes the `// N:` comment):

> Session apps publishing (docs/feat/session-apps-publish.md): a permission_request
> whose tool is `app_publish` (publishing a presented HTML artifact as a public web
> page) must NEVER be auto-accepted, and it is offered allow-once or deny only. An
> older client's auto-accept would answer it allow-once, putting a page on the public
> internet with no human, so a mixed pair must fail at initialize instead. Additive
> in the same task: the display update `apps`, the snapshot field `apps` and the
> method `session/app_unpublish`.

`changelog.d/session-apps-publish.added.md`:

> - **Publish a page as a session app.** With `apps.enabled` on, the agent can publish an HTML page it has already shown you (`present`) at a public address under `apps.tentacle.so`; you approve every publish and every update (never «always»), the approval shows any secret-looking text found in the page, and the page stays up while the session is open. `/apps` (and the phone's session info) lists them with their state and stops one. Off by default until the apps host is deployed.

### Failure modes

| # | Failure | What happens / how state converges |
|---|---|---|
| F1 | **Forged publish** — something other than the owner tries to make the daemon publish | Only the model's tool call reaches `publish`, and only after an ask of kind `app_publish`: never auto-accepted (daemon, client, relay policy), never `always`, never an external caller (Load-bearing). A pod is not offered the tool (D1) and its `apps` list is dropped by the laptop (`daemonWakes`). `session/app_unpublish` can only REMOVE, and needs the session open on that connection. A sub-agent has no tool (`subagent.ts` filter). |
| F2 | **Replay** of a signed request (a log, a proxy) | Host refuses a seen `(key, nonce)` or a stale `Date` (P1 D3); the domain is signed, so the interim domain's requests are void at the final one. The publisher never resends a signed request: every retry re-signs. |
| F3 | **Lost create response** (timeout after the host stored it) | No automatic retry of a create (it would publish twice). The tool says «the host did not answer; if it received the page it goes offline within 5 minutes». The orphan is never renewed and lapses (P1 D3); it holds one of the key's 5 slots for ≤ 5 min. |
| F4 | **Lease stops renewing** — laptop asleep, network down, serve down < 5 min | Rows go `renewing`; retries with backoff 1 s … 60 s; once the LOCAL clock passes `lastOkSentAt + leaseMs` the row is `down` (the visitor sees the host's offline page). Recovery: a renew answers OK → `up`; `410 expired` → revive with the held bytes, same URL (D4) → `up`; bytes gone → `down` «publish again», timer stopped. |
| F5 | **Serve restart** | Sidecar v5 holds the records; the reloaded session renews at once. < 5 min: still `up`. > 5 min: `expired` → the serve's artifact bytes did NOT survive (memory only) → `down` «publish again» (residual, Notes). An older build refuses the session (v5), loudly — never drops its apps. |
| F6 | **Host restart** | Host gives live apps one fresh TTL (P1 D8). A few seconds of `409 replay` for a slow clock → transient, retried; `clock_skew` → offset from `serverTime`, one re-sign. |
| F7 | **Huge / malformed upload** | Refused before asking: not html, > 10 MiB, invalid UTF-8, empty. The host still enforces (413/415/400 → mapped text). |
| F8 | **Id collision / guessing** | Ids are host-minted, 80 bits (P1 D4); the client checks shape and URL. Two sessions of one daemon claiming one id (a copied sidecar) → the second record is dropped with a log line (one owner per id). Another key cannot renew/update/delete an id (`403 forbidden`) → that row `removed`. |
| F9 | **Abuse-report flood** | Reports never act automatically (P1 D13); a flood changes nothing for the publisher. An operator takedown → renew `403 taken_down` + reason → row `removed` with the reason shown in the session (DSA statement of reasons), timer stopped; republishing asks again and the host refuses that id; a key block (`blocked`) refuses every publish with the reason. |
| F10 | **Kill switch** | `publish`/`all`: create/update → `503 killed` → «publishing is paused by the operator» (nothing asked again automatically). Renewals keep working (P1), so rows stay `up`; under `all` visitors see the maintenance page — the publisher cannot tell (residual, stated in the runbook). |
| F11 | **Disk full** | Host `507 storage_full` → «the apps host is full — try later». Local: the key file cannot be created → nothing published, the error says where; the sidecar write fails → the persister's existing failure path; on a later restart without the record the app lapses within one lease (offline, never more exposure). |
| F12 | **Session ends mid-publish** | The ask settles `cancelled` → nothing published. Already approved and uploading → the create completes, then `DELETE` at once (D14); the row never appears. |
| F13 | **Stop races a renew** | One operation per app: Stop aborts the in-flight renew, then `DELETE`; a renew answer arriving after Stop is ignored. |
| F14 | **`DELETE` lost on close** (offline, process exit) | The row is gone locally; the page stays up until its lease lapses (≤ 5 min), then offline, tombstoned. Bounded, stated in Notes. |
| F15 | **Unknown/garbage key file** | Refused with its path («fix or remove it; removing it makes a new key and your current apps cannot be renewed»); never replaced silently. |
| F16 | **Per-key cap** (5 live apps for the whole host) | `409 cap_reached` → «this computer already has 5 live apps — stop one (`/apps`)». |
| F17 | **Version skew** | Older client ↔ newer daemon: `initialize` fails (`protocol.d` note). Newer client ↔ older daemon: no `apps` frames, no snapshot field (absent = «not reported», never «none»), `session/app_unpublish` → `MethodNotFound` → notice. |
| F18 | **Domain changed in config while apps are live** | Renewals are signed for the configured domain; the old host's apps fail to verify → transient until lease lapse → `down`. Runbook §10/§12 says: change the domain with no live apps. |

### Tests

Red before green for every new behaviour (§9): each test is written and shown
failing on the code before its slice, then green. Fakes only: injected `fetch`,
clock, `setTimeout`; an in-memory artifact store; `SpyBroker`-style requesters;
the real P1 host on `port: 0` for the one end-to-end contract test. Poll with
`until`/`untilAsync` (`packages/client/test/support/fakes.ts`), never a fixed sleep.

- **S1 `packages/core/test/permission.test.ts`** — `app_publish`: `autoApproves`
  false (own turn, auto-accept on), `onceOnlyAsk` true, `externalMayAnswer` false
  (and `packages/core/test/permission-kinds.test.ts`, which pins the kind table).
  **`packages/daemon/test/permission-map-apps.test.ts`** (new, pattern
  `permission-map-workflow.test.ts`) — options are exactly `allow_once,reject_once`
  (Repro 2's last line is the red).
  **`packages/client/test/permission-router.test.ts`** — wire tool `app_publish` →
  kind `app_publish`. **`packages/daemon/test/external-asks.test.ts`** — a caller
  in `both` mode may not answer it.
  **`packages/agent/test/redact.test.ts`** — `findSecrets`: each rule's hit with its
  line; the matched value appears nowhere in the result; cap 20; clean text → `[]`.
  **`packages/agent/test/subagent.test.ts`** — a child's registry has neither tool.
  **`packages/protocol/test/*`** — `apps` update parses with an unknown `state`
  string; `UPDATE_CLASS.apps === "display"`; method registry entry; json-schema drift.
- **S2 `packages/daemon/test/apps-lease.test.ts`** (pure, table-driven): every
  event × state; next renew uses the LOCAL send time (a host clock 10 min ahead
  changes nothing); `down` exactly when local time passes `lastOkSentAt + leaseMs`;
  `expired` → `revive` only with bytes; `taken_down` → `removed` + reason + `stop`;
  backoff never 0, capped.
  **`packages/daemon/test/apps-client.test.ts`** (fake fetch): headers and payload match
  `appsSigningPayload`; `host` header = domain; fresh nonce per retry; `clock_skew`
  → one re-sign with the corrected date, a second one → error (no loop); a url not
  under the domain → `internal` + `DELETE` of the created id; timeouts.
  **`packages/daemon/test/apps-key.test.ts`** — created 0600 in a 0700 dir; two racing creators → one
  key; unreadable/garbage file → refusal, file untouched.
  **`packages/daemon/test/session-apps.test.ts`** — prepare refusals (unknown artifact, not html,
  > 10 MiB, evicted, already live); `publish` with tampered bytes → refused; update
  keeps the URL; Stop aborts a running renew; close mid-create → `DELETE` after the
  create answers and no row; `endAll` fires one `DELETE` per app; restore arms a
  renew per record; the per-daemon owner map drops a duplicate id.
  **`packages/daemon/test/apps-session.test.ts`** (new, pattern `schedules.test.ts`,
  which drives a `SessionHost` with a persister) — a publish emits `apps` and calls
  `persist`; the snapshot carries `apps`; `close`/archive/reaper/delete all end
  the apps (the archived record has none); `/clear`'s fork has none; the sidecar:
  `apps` written only when non-empty, stamped 5; a v4 file with `apps` refused; v5
  round trip through a restart (renew armed at once); malformed `apps` refused.
  **`packages/daemon/test/apps-connection.test.ts`** (new, pattern
  `artifact-connection.test.ts`) — `session/app_unpublish` happy/unknown; a
  `session/close` reply waits for a slow `DELETE` but never more than 3 s (fake clock).
- **S3 `packages/tools/test/app-publish.test.ts`** — the ask is built by the pure
  `appPublishAsk` (title/detail per case; findings named, values absent; model
  text flattened); denied → nothing published; the broker is the injected one
  (a SECOND spy broker never sees the ask — the single-broker mutation check, as
  the `runEngineTui` regression); no link → error.
  **`packages/cli/test/wiring.test.ts`** — tools registered iff `apps` passed;
  **`tunnelledAgent` builds no `app_publish`** even with `apps.enabled` in the pod's
  config; `serve`/worker pass it only with `apps.enabled`.
  **`packages/config/test/*`** — defaults, validation of `apps.domain`.
- **S4 `packages/client/test/apps.test.ts`** (new, pattern `schedules.test.ts`) — `apps` frame and snapshot
  delivered with `daemonWakes`, DROPPED without; `unpublishApp` refuses locally
  without sending when untrusted. **`packages/tui/test/apps-view.test.ts`** (pure)
  — rows, status label, quit text, `appStateOf("weird")` ≠ up.
  **`packages/tui/test/app.test.tsx`** — `/apps` opens the panel from the feed;
  `s` sends `session/app_unpublish`; the `app_publish` ask shows two options only
  (frame capture, AGENTS §1).
- **S5 `apps/mobile/test/session-info-apps.test.ts`** (new, pattern
  `session-info-schedules-render.test.ts` and `session-info-controller.test.ts`) — `appsSection` rows/empty/error;
  controller Stop calls `unpublishApp`; `permission-sheet` offers no «always» for
  `app_publish`. Simulator pixels are verified by the orchestrator's simulator sweep,
  not here.
- **Contract `apps/apps-host/test/publisher-compat.test.ts`** — the daemon's
  `AppsClient` (relative import) against `startHost` (`test/support/host.ts:32`):
  create → renew → update (same URL) → lapse (host clock) → `410` → revive with
  `PUT` → delete → `410 deleted`; a takedown line → `403 taken_down` + reason. This
  is the one test that proves both ends agree byte for byte.
- **Mutations to run in Review** (each must turn a test red): drop `app_publish`
  from `onceOnlyAsk`; let `autoApproves` accept it; register the tool in
  `tunnelledAgent`; pass a second broker to the tool; skip the re-hash in
  `publish`; remove the `daemonWakes` gate on `apps`; write the sidecar `apps` as v4.

**Unverified by CI** (owner smoke, runbook §12): a real publish from a real session
against the deployed host, the phone section's pixels, a laptop sleep > 5 min
followed by the automatic revive.

**Notes / debt (deliberate):** a `serve` restart longer than one lease loses the
ability to revive (its artifact bytes are memory only) — closes when the serve's
artifact disk copy lands (`model-artifacts.md` D5/S4); a lost `DELETE` leaves a page
up ≤ 5 min (F14); the publisher cannot see the host's `all` kill switch (F10); pods
(P4), the phone «Live» card and hub badge (P3), network-on apps (owner A3, later).

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Load-bearing re-check (before any edit): holds.** `ask.ts` and `key.ts` re-run
from the worktree gave the Repro's output (the kind-less `app_publish` ask:
`autoApproves true options allow_once,allow_always,reject_once`; Ed25519 verify
`true`), the capability `rg` still listed only the P1 contract and its test, and
`autoApproves` / `onceOnlyAsk` / `EXTERNAL_ANSWER` / `toPermissionRequest` /
`askOf` / `permissionOptions` / `a2a-add-agent.ts` read as cited. Also checked:
the one-shot and plain CLI paths (whose broker approves all) build the agent
without the `apps` link, so they have no publish tool.

**As built** (S1–S6, in order; nothing committed):

- **S1** contract and kind: `APPS_MAX_APP_BYTES_DEFAULT`, `AppRowSchema`, the
  `apps` display update and snapshot field, `session/app_unpublish`,
  `protocol.json` regenerated, `protocol.d/session-apps-publish.md`,
  `core/apps.ts`, the `app_publish` kind, `findSecrets`, the sub-agent filter, the
  client and external mappings.
- **S2** daemon: `apps-key.ts`, `apps-client.ts`, `apps-lease.ts`,
  `apps-records.ts`, `session-apps.ts`, `ArtifactStore.bytesOf`, sidecar v5,
  `HostedSession` / `SessionHost` / `Connection` wiring, the real-host contract
  test.
- **S3** `app-publish.ts`, `apps.enabled` / `apps.domain` (README table
  regenerated), `serve` / worker / `buildAgent` wiring.
- **S4** `client/apps.ts` and the gated feed; TUI `/apps`, status words, quit
  warning, publish options.
- **S5** phone «Apps» section with Copy and Stop, publish options.
- **S6** runbook §12, changelog fragment.

**Drift from Implementation** (each small; why):

1. `PreparedPublish` also carries `ok: true` (the union's discriminator) and
   `domain` (the ask names `https://*.<domain>`).
2. A fifth daemon file, `apps-records.ts` (record + pure parser), so the sidecar
   module does not import the publisher.
3. An app the host no longer knows (`deleted` / `not_found` / `forbidden`) is
   replaced by a **create** on the next publish; an update could only fail
   forever. A taken-down one still updates and is refused by the host (F9).
4. D14: a **create** is never aborted (only its answer names the id to delete);
   an update is aborted by Stop or the session's end.
5. A revival answered `expired` is retried with backoff, never at once. Every
   non-terminal code retries.
6. A restored row is `renewing` and lapses one default lease after the restore.
7. The 3 s close wait is `SessionApps.drained(ms)` (the service's clock), and
   only a session with something to delete waits.
8. TUI status words ride the status bar's suffix beside the switches' marker
   (`app-layout.ts`), not the dock pill: the pill opens a list that holds no apps.
9. `appStateOf` lives in `client/apps.ts` (the phone needs it), re-exported by
   `tui/apps-view.ts`.
10. Phone: **no** section when nothing was reported (apps are off by default, so
    «update tentacle» would usually be false). `App.tsx`, `SessionScreen.tsx` and
    `session-screen-controller.ts` also changed (the port and the two callbacks).
11. Test files: wiring cases are in `cli/test/apps-hosts.test.ts`, the app frames
    in `tui/test/apps-panel-app.test.tsx`.
12. Existing tests updated for new facts: schema fixtures, the daemon's update
    samples, "unknown sidecar version" is now 6, the TUI's command and panel
    lists, the runbook's section list (§12).

**Red before green.** Shown red on their assertions before the code: the protocol
wire test (5/5), the kind table, router, external ask, permission options,
sub-agent filter and `findSecrets` (21 red, with a `findSecrets` stub). The new
modules (S2–S5) had their tests written with the module, **not** shown red first;
their non-vacuity rests on the mutations below and on Review.

**Mutations** (each applied, run, reverted):

| Mutation | Result |
|---|---|
| drop `app_publish` from `onceOnlyAsk` | 4 fail |
| `autoApproves` accepts `app_publish` | 2 fail |
| register the tool in `tunnelledAgent` | 1 fail — the first run **passed** (only the non-proxy pod path was driven); a `tunnelledAgent` test was added |
| a second broker handed to the tool | 1 fail |
| skip the re-hash in `publish` | 1 fail |
| remove the `daemonWakes` gate on `apps` | 2 fail |
| write the sidecar `apps` as v4 | 6 fail |

**Checks run** (narrow, per the brief): protocol, core, agent, tools, scripts,
daemon, config, cli, client, tui, apps-host and mobile tests green after the
updates above; `tsc -p apps/mobile` and `tsc -p apps/apps-host` clean;
`biome check packages apps/apps-host apps/mobile` clean. The root
`tsc --noEmit` and the full gate were **not** run here. One apps-host overload
test failed once beside the protocol suite and passed on re-run.

**Open for Review / not verified:**

- **Secret-scan cost.** `findSecrets` runs the redaction rules synchronously over
  up to 10 MiB. Ordinary pages: 33–53 ms for 10 MiB. A crafted run is quadratic
  (`"a."` or `"eyJ-"` repeated: 32 KiB ≈ 100–140 ms, 64 KiB ≈ 560–600 ms), so a
  crafted multi-MiB page would stall the daemon. The cause is the shared rules'
  unbounded quantifiers (`url-credentials`, `jwt`); changing them also changes
  output redaction, so it was left for a decision.
- Turning `apps.enabled` off and restarting `serve` rewrites a session's sidecar
  without its apps: nothing renews them and the pages lapse within one lease.
- A real publish against a deployed host, the phone pixels, and a laptop sleep
  with revival (runbook §12).

## Review

*— claude-opus-5-5, 2026-11-26* (fresh context; same model family as the planner, different from the executor)

**Verdict: REQUEST-CHANGES.**

**Gate.** `bun run typecheck` clean; `bun run lint` clean (2699 files). `bun run test`:
20576 pass · 5 skip · **6 fail** / 20587. When re-run alone, `scripts/test/release.test.ts` and
`packages/cli/test/attach-run.test.ts` pass (timeouts under parallel load, not this
branch). **One failure is this branch's**: finding 1.

**Findings**

1. **HIGH: the worker runtime never forwards the apps feed or Stop; the gate is red.**
   `packages/cli/test/subagent-panel-controller.test.ts:361` (GUARD, exact set) fails
   with `+ "onApps", + "unpublishApp"`. Cause: `SessionController` in
   `packages/cli/src/local-runtime.ts:379-382` and `persistingController` (`:980-985`)
   forward `onSchedules`/`deleteSchedule` but not `onApps`/`unpublishApp`.
   Scenario: in a plain `tentacle` TUI (the in-process worker, a D1 runtime) with
   `apps.enabled`, the agent publishes a page. `/apps` stays empty, there is no
   status segment, the quit warning «quitting takes 1 live app offline» never shows, and
   `s` reports unsupported (`usePanels.ts:438`). Only `connect` works.
   `tui/test/apps-panel-app.test.tsx` misses this because it hands the App a raw session,
   not the runtime wrapper. Fix: forward both, add them to the GUARD list, and add a
   worker-runtime test.
2. **MEDIUM: an unbounded secret scan runs before the ask and blocks the daemon.**
   `packages/daemon/src/session-apps.ts:277` runs `findSecrets(text)` synchronously
   inside `prepare`, before any human is asked. It is quadratic on crafted input (measured
   here: `"a."` × 64 KiB 331 ms, 128 KiB 1.3 s, 256 KiB 5.2 s → 10 MiB ≈ 2 h).
   Scenario: a prompt-injected model `present`s a crafted 10 MiB page and calls
   `app_publish`. The `serve` event loop is frozen for hours: every session stalls, and
   every app's renewal stops, so all of them go `down`. Real bundles are fine (mermaid.min
   3.4 MiB: 24 ms; d3, katex, cytoscape ≤ 3 ms). Fix: bound the scan (cap the line
   length or the input scanned, use linear-safe scan-only patterns, or run it off-thread
   with a deadline) and say so in the ask.

**Mutations (mine, each reverted; `git status` clean after):** without the `DELETE`
on a session that ended mid-create → `session-apps.test.ts` red. Without the
`daemonWakes` gate on the snapshot's `apps` → `client/test/apps.test.ts` red. Without
the close reply's wait → `apps-connection.test.ts` 2 red. The executor's seven
planned mutations are recorded in Execution; I did not re-run them.

**Attacks tried, with no finding:** whether an "always" rule or a rule matched by tool
name could answer the ask. The tool is `permission: "none"`, the broker goes straight to
`awaitDecision`, and `autoAnswers` only uses `browserAutoAnswers` and `autoApproves`
(`hosted-session.ts:1927-1943`). The worker's broker before
`setRequester`: none of the agent's turns run before `hosted-session.ts:1456`. Persisting on
close, archive and `serve` stop: `endAll` drops the rows first, so the archive record has
no apps; `dispose` keeps the records for the restart. External A2A: `owner-only`.
Sub-agents: both filters. Pods: `tunnelledAgent` gets no link.

**Executor behaviour.** Execution is honest: the scan's cost and the gate it had not run
are both stated. The "script gate failures" commit still left the GUARD test red: the
full gate was not re-run before review.
