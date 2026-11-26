# feat/container-apps-devices — a live container port, private to the paired devices

> **Status:** implementation (APPROVED — orchestrator, owner-delegated)
> **Branch:** `feat/container-apps-devices` — **this branch = slice S1 (serve + protocol)**; S2 (phone) is `feat/container-apps-devices-phone`, its own doc, after S1 merges
> **Type:** feat · **Size:** L overall → split; S1 = M · **Blast:** load-bearing (what a workload can expose; new bytes on the device channel) · **Suited:** Opus plan + fresh-context Opus security review, Sonnet exec
> **Changelog:** none in S1 (the tool ships OFF and nothing is viewable yet); S2 writes `changelog.d/container-apps-devices.added.md` and turns it on

## Context

*— claude-opus-5-5, 2026-11-26*

The owner wants to see a container's web port that is running on their `serve` host (a dev server, a demo) **on the phone**, without a public URL. This is
option (4) of `docs/feat/session-apps.md` §7 (the owner's choice, TODO item
`feat/container-apps-devices`, «partiamo dalla versione privata sui
dispositivi»). These §7 trust rules are binding:

- any local container; the **owner approves EACH exposure** through the
  session's one broker; **never `allow_always`** (and never auto-accept);
- the prompt names engine / container / image / port **as the engine reports
  them**, never as the model describes them; the workload never chooses what
  is exposed;
- refused: host-network, privileged, the engine socket, a remote engine
  (`tcp://`/`ssh://`);
- the serve dials the container's **published loopback port**, **re-resolved on
  every new connection**;
- HTTP/1.1 + WebSocket only (no raw TCP);
- down when the session, the container or the link ends.

**Repro (capability missing), 2026-11-26, `72425b9a`:**
```
$ rg -n "container_preview|preview_connect|preview/data" packages apps --type ts | wc -l
       0
```
No tool proposes an exposure, no RPC carries bytes to a local port, and the
phone has no viewer.

**Split.** S1 (this branch) = everything on the serve and the wire, testable
end-to-end with a fake engine and a real loopback server, shipped **OFF**
(`previews.enabled: false`). S2 = the phone: a loopback listener (native module)
+ a pure gate + a WebView viewer + the session chip + a hub entry and badge
(mockups first, ≥ 2 variants), then default ON + changelog. S2's outline is in
Notes below so S1's wire shape is designed for it.

## Implementation

*— claude-opus-5-5, 2026-11-26*

### Load-bearing assumption

**An HTTP/WebSocket byte stream can ride the phone's EXISTING device
`Connection` as RPC messages, in order and with backpressure, so S1 adds no
relay stream, no second Noise accept and no second session path.**

- The phone↔serve channel is Noise → one `Connection`, the same on the relay
  leg and on the direct `/e2e` route: `packages/daemon/src/device-accept.ts:2-15`
  ("its accept leg is a `ByteCarrier` too, and no second authentication or
  session path exists"), built on the resolved channel
  (`device-accept.ts:31`, `Connection` constructor `connection.ts:255-269`).
  The relay only pairs sockets and never authenticates (`apps/relay/src/relay-core.ts:5-11`);
  its per-daemon budget is `streamsPerId: 64` (`relay-core.ts:51`). Tunnels
  inside the phone's one stream do **not** touch that budget. A stream per
  tunnel would cost ~6–8 per page (browser connection pool + WS) and need a
  non-RPC Noise accept. That would be a second path, so it is rejected.
- **Ordering:** `RpcPeer.receive` dispatches every frame synchronously in
  arrival order (`packages/transport/src/peer.ts:280-333`), and
  `handleNotification` reaches `onNotification` before its first `await`
  (`peer.ts:389-421`). A handler that synchronously writes or enqueues therefore sees
  `preview/data` chunks in wire order. Requests stay concurrent
  (`peer.ts:325`, §7 "don't serialize the RPC peer"). The tunnel adds no lock.
- **Backpressure:** a `node:net` socket in Bun really stops reading when paused
  (scratch check, Bun 1.4.3, `.tentacle/tmp/container-apps-devices/pause.ts`):
  ```
  while paused, received 0 extra bytes
  total 4194304 bun 1.4.3
  ```
  So a per-tunnel credit window can bound what the daemon buffers. The
  window is acked by notification, and the socket pauses when credit is out.
- **Daemon→client notifications that are not `session/update` already exist**,
  sent only to a connection that asked for them (`daemon/discovery`,
  `packages/protocol/src/methods.ts:319-323`). Tunnel notifications follow the
  same rule: sent only on a connection that opened that tunnel.
- **Frame cap:** a device connection parses frames up to 8 MiB
  (`device-accept.ts:40`). A 32 KiB chunk (≈ 43 KiB base64 in JSON) is far
  below it.

### Preconditions

- **Device-only gate exists:** `principal.kind` is fixed at the handshake
  (`connection.ts:182-190`). Device-only methods refuse other principals with
  `Unauthorized` (`connection.ts:616-622`, push). A pairing connection can do
  nothing but `device/pair` (`connection.ts:394-399`). A session command
  requires the session to be OPEN on this connection (`lookup`,
  `connection.ts:973-983`).
- **Ask precedent, `app_publish`:** a tool with `permission: "none"` raises its
  OWN ask kind on the session's one broker (`packages/tools/src/app-publish.ts:1-6,
  108-123`). The kind is in the `PermissionRequest.kind` union
  (`packages/core/src/permission.ts:67-75`). It is excluded from auto-accept
  (`permission.ts:399-417`; the daemon's own auto-answer goes through the same
  `autoApproves`, `packages/daemon/src/hosted-session.ts:1933-1950`). It is
  once-only (`onceOnlyAsk`, `permission.ts:443-450` → the daemon offers only
  allow_once/reject_once, `packages/daemon/src/permission-map.ts:24-41`; the
  phone hides "always" through the same predicate,
  `apps/mobile/src/permission-sheet.ts:285-310`). It is owner-only for external
  callers (`EXTERNAL_ANSWER`, exhaustive, `permission.ts:134-152`). The wire →
  kind mapping on clients is by tool name (`packages/client/src/permission-router.ts:155-166`).
- **Host-only lazy link precedent:** `apps` is a lazy per-session link handed to
  the agent factory ONLY where the host publishes. Never on a pod daemon:
  `packages/daemon/src/session-host.ts:182-189, 1728, 1839`; the serve passes it at
  `packages/cli/src/serve.ts:276-278`; the factory offers the tool at
  `packages/cli/src/wiring.ts:1498`. Sub-agents are filtered at
  `packages/agent/src/subagent.ts:543-547, 792`.
- **Session-level list update precedent:** `apps` is a display-class full-list
  update (`packages/protocol/src/updates.ts:447-456`, class `updates.ts:608`),
  replayed through the attach cut (`hosted-session.ts:2652-2654`,
  `OpenResult.apps` `packages/protocol/src/session.ts:1629`). The cut is in
  memory. What persists is `apps.records()` → the sidecar
  (`packages/daemon/src/session-persister.ts:558`,
  `daemon-state-file.ts:86-146`). Previews add **no** record, so nothing new is persisted.
- **Engine inspection:** `DockerClient.inspectContainer(id)` → `GET
  /containers/{id}/json` (`packages/docker/src/client.ts:331-338`). The typed
  `ContainerInspect` today reads only `Id/Name/State/Config.Labels`, with an
  index signature (`packages/docker/src/types.ts:9-21`); Podman uses the same
  compat API through the same client. `EngineEndpoint.local` is `true` only for
  `unix` and `false` for `tcp`/`ssh` (`packages/docker/src/engine-endpoint.ts:23-42`).
  Endpoints resolve from env with `resolveEngineEndpoint` (`engine-endpoint.ts:70`)
  and `resolvePodmanEndpoint` (`podman-endpoint.ts:83`). A client is
  `new DockerClient({ dial: dialerFor(ep), endpointLabel: endpointLabel(ep) })`
  (`packages/cli/src/engine-select.ts:268-270`). `@tentacle/daemon` does **not**
  depend on `@tentacle/docker` (`packages/daemon/package.json:12-19`); `cli`
  does (`packages/cli/package.json:20`). So the engine resolver is built in
  `cli` and injected.
- **Phone loopback HTTP is allowed by ATS:** `NSAllowsLocalNetworking: true`
  (`apps/mobile/app.json:21-22`) (S2).

#### Orchestrator decisions

Owner-delegated. Each one is the recommended option. None weakens a §7 rule.

- **OD1 — Who proposes:** a model tool `container_preview {container, port,
  engine?: "docker"|"podman"}` (default `docker`). The model names a container
  and port. The **ask** shows only what the engine returns. The phone cannot
  start an exposure in v1 (S2 may add "preview a container" from the hub later, through the same ask).
- **OD2 — Ask kind `container_preview`:** once-only, never auto-accepted (the
  serve's own auto-answer included), owner-only for external callers, never
  offered to sub-agents. This is the `app_publish` treatment line for line.
- **OD3 — Which bindings count as "published on loopback":** a `tcp` port binding with
  `HostIp` ∈ {`127.0.0.1`, `0.0.0.0`, `""`} → dial `127.0.0.1:<HostPort>`.
  The ask says "also reachable on your LAN" when it is `0.0.0.0`/`""`. That only
  states what the user already did; we expose nothing new. IPv6-only and
  any other address → refused, with the hint `-p 127.0.0.1:<host>:<port>`.
- **OD4 — "The engine socket":** refuse a container with any mount whose `Source`
  or `Destination` is the endpoint's socket path or has basename `docker.sock` /
  `podman.sock`. A UI that drives the engine is root on the host.
- **OD5 — Viewer = paired devices only:** tunnel methods require
  `principal.kind === "device"`. A `connect` TUI (token principal) may **answer**
  the ask (it is the owner), but cannot open a tunnel. This is stricter than the minimum.
- **OD6 — Not persisted:** previews are in memory only. A serve restart drops them,
  and the model asks again. No on-disk format change.
- **OD7 — Limits (constants in protocol):** ≤ 8 previews per session, ≤ 32
  tunnels per connection, chunk ≤ 32 KiB raw, window 256 KiB un-acked per
  direction per tunnel.
- **OD8 — Ship OFF:** config `previews.enabled` (default `false` in S1, flipped
  to `true` in S2). The tool is offered only by `serve` with it on: never the
  worker (no paired device can view a worker session) and never a pod daemon.
- **OD9 — No model "stop" tool:** stopping belongs to the user (`session/preview_stop`, a device
  request; S2's viewer offers it) and to the lifecycle. The model can only
  propose.

### Design

**Serve side.**

1. `container_preview` (tools) → `link.prepare({engine, container, port})`. The
   cli resolver resolves the endpoint from the serve's env. It refuses a non-`local`
   endpoint, runs `inspectContainer(container)`, then the pure
   `previewTargetOf(inspect, port, endpoint)` (docker package), which returns
   `{ok, facts:{engine, endpointLabel, id, name, image, imageId, containerPort,
   hostPort, hostIp}}` or `{ok:false, reason}`. Refusals: not running,
   `HostConfig.NetworkMode === "host"`, `HostConfig.Privileged`, an engine-socket
   mount (OD4), port not published per OD3, non-`tcp`. A refusal returns before any
   ask.
2. The ask (pure `containerPreviewAsk(facts)`). Title: `Show container
   <name> port <p>/tcp on your paired devices?`. Detail lines: `Engine:
   docker · unix:///…sock`, `Container: <name> · <id12>`, `Image: <image> ·
   <imageId12>`, `Port: <p>/tcp → 127.0.0.1:<hostPort>[ (also on your LAN)]`,
   `Only your paired devices can open it, while this session is open`. Every
   engine string goes through the same `line()` sanitizer as `app-publish.ts:30-37`.
   `input` carries `{id, port}` only.
3. Allowed → `link.add(facts)` → the session's `previews` gains a row
   `{id: random 128-bit, containerId (FULL id), engine, name, image,
   containerPort, createdAt}` and emits `previews` (full list). It goes into the cut
   (attach snapshot) but **not** into the persisted state.
4. **Tunnel (Connection, device only).** The request `session/preview_connect
   {sessionId, previewId}` → `lookup` (open here) → device check → the
   session's resolver **re-inspects by the recorded full id** and re-runs
   `previewTargetOf`. On any failure the preview is REMOVED (`previews` emitted)
   and the result is `PreviewGone`. Otherwise it dials
   `127.0.0.1:<fresh hostPort>` (injected `dial`, `node:net`) → `{tunnelId}`.
   The dial is refused → error, and the preview is kept: a dev server may be
   restarting. A container that was gone is removed at once.
   - `preview/data {tunnelId, data: base64}` in both directions; `preview/ack
     {tunnelId, bytes}` in both directions; `preview/close {tunnelId, reason?}` in
     both directions. The daemon pauses its socket when the phone's un-acked bytes
     reach the window and resumes on ack. It acks the phone's bytes after the socket
     `write` callback. Data beyond the window, a bad base64 or an unknown tunnel →
     `preview/close` with a reason (never a throw out of the handler).
   - **HTTP/1 only:** the daemon forwards phone bytes only after the first
     line of the tunnel matches an HTTP/1.x request line (`METHOD SP target SP
     HTTP/1.[01] CRLF`, ≤ 8 KiB). Otherwise close. A WebSocket upgrade is an HTTP/1.1
     request, so it passes; `PRI * HTTP/2.0` and raw protocols do not. A pure function.
   - `session/preview_stop {sessionId, previewId}` (device) → remove + close
     its tunnels on every connection.
5. **Lifecycle convergence:** the session closes or is archived → previews
   cleared, every tunnel of the session closed (`preview/close reason:"session"`).
   `Connection.close()` (phone gone, device revoked, relay link down) → its
   tunnels closed (`connection.ts:281-294` teardown). The container stopped →
   the upstream socket ends → tunnel closed, and the next connect removes the
   preview. The daemon stops → all sockets closed.

**Shared truth / both ends.** Schemas in `@tentacle/protocol/preview.ts`
(rows, params, notifications, limits). The `previews` update gets a union member +
`UPDATE_CLASS: "display"` + its reverse mapping in `client/mapping.ts`
(`mapping.ts:384` is the `apps` precedent). Optional `SnapshotResult.previews`
(corrected in Execution: `session.ts:1629`, the `apps` precedent, is the
snapshot result, not `OpenResult`; the cut reaches a client through the snapshot).

**Versioning.** All additive (new methods → `MethodNotFound` on an older
daemon; new notifications sent only on a tunnel the peer opened; a display
update; an optional result field). So **no `protocol.d/` note** and no
`PROTOCOL_VERSION` edit. If the executor finds a change that is not additive,
STOP and write `protocol.d/container-apps-devices.md`.

### Files

In dependency order (S1):

1. `packages/protocol/src/preview.ts` (new) + `methods.ts` (`Method.PreviewConnect =
   "session/preview_connect"`, `Method.PreviewStop = "session/preview_stop"`,
   `Notification.PreviewData/PreviewAck/PreviewClose = "preview/data|ack|close"`,
   both registries) + `updates.ts` (`PreviewsUpdateSchema`, union, class) +
   `session.ts` (`SnapshotResult.previews?`) + `index.ts`.
2. `packages/core/src/permission.ts`: kind `container_preview`. Add it to
   `autoApproves`'s exclusions, `onceOnlyAsk` and `EXTERNAL_ANSWER: "owner-only"`.
   `packages/core/src/previews.ts` (new): `CONTAINER_PREVIEW_TOOL`, `PreviewFacts`,
   `PreviewsLink {prepare, add}`, `PreviewResolver {prepare(req), resolve(row)}`.
3. `packages/docker/src/types.ts`: typed `Config.Image`, `Image`,
   `HostConfig.{NetworkMode,Privileged}`, `NetworkSettings.Ports`, `Mounts`.
   `packages/docker/src/preview-target.ts` (new, pure) + export.
4. `packages/tools/src/container-preview.ts` (new; `app-publish.ts` shape) +
   export. `packages/agent/src/subagent.ts`: filter it (both lists, `:546`, `:792`).
5. `packages/daemon/src/preview-tunnels.ts` (new): the tunnel table per connection,
   credit window, the HTTP/1 first-line check, injected `dial`.
   `hosted-session.ts`: the previews list, `previewsLink()`, `previewsChanged()`
   (emit only, no `persist()`), cut field, cleared on close.
   `session-host.ts`: option `previews?: PreviewResolver`; lazy link at the two
   `createAgent` sites (`:1728`, `:1839`). `connection.ts`: the two request cases
   (device gate), three notification cases, tunnel teardown in `close()`.
   `external/asks.ts`: tool → kind.
6. `packages/client/src/permission-router.ts` (tool → kind);
   `packages/client/src/mapping.ts` (`previews`).
7. `packages/config`: `previews.enabled` (default `false`) + `key-docs.ts`.
   `packages/cli/src/serve.ts`: build the resolver (docker + podman endpoints from
   env, `DockerClient` per call) and pass it ONLY when enabled.
   `packages/cli/src/wiring.ts`: `AgentContext.previews` → offer the tool.
8. `packages/tui/src/permission-ui.ts` + `apps/mobile/src/permission-sheet.ts`:
   labels `Show once` / `No` (the `app_publish` branch shape). This is the only phone
   file in S1, so the owner can answer the ask from the phone.

### Failure modes

| Case | Convergence |
|---|---|
| Model names a container by a misleading name/label | The ask shows the engine's `Name`/`Id`/`Image`. The model's string is only the lookup key. |
| Container replaced under the same name after approval | The row holds the FULL id, and re-inspect by id fails → removed, `PreviewGone`. |
| Container restarted, host port changed | Re-resolved per connect → dials the new port. |
| Something else took the old host port after a stop | Re-inspect by id says not running → removed. We never dial a raw stored port. |
| Remote engine / host-net / privileged / socket mount / not published | Refused before any ask, with the reason returned to the model. |
| Auto-accept ON (client or the serve's own) | `autoApproves` excludes the kind → a human answers. |
| Old phone gets the ask with no kind | The daemon still offers only once/deny. An "always" tap is `InvalidParams` and the ask stays pending (`permission.ts` protocol rule). |
| Token/pairing connection calls `preview_connect` | `Unauthorized`. A session not open → `UnknownSession`. |
| Phone floods data (ignores the window) | Tunnel closed with `window`. Bounded memory. Other tunnels and the session are unaffected. |
| Phone stops acking (backgrounded) | The daemon socket stays paused. The tunnel dies with the connection or the upstream's own timeout. Nothing buffers past 256 KiB. |
| First bytes not HTTP/1 | Closed, nothing forwarded upstream. |
| Session close/archive, `/clear` | Close/archive → cleared + tunnels closed. `/clear` keeps them (session-level, like `apps`). |
| Connection drops mid-tunnel | `close()` destroys its sockets. The previews stay for the next device connection. |
| Serve restart | Not persisted → gone. The model must ask again. |
| Engine unreachable at connect | Error result. The preview is kept (transient), and the next connect re-checks. |
| 9th preview / 33rd tunnel | Refused with a reason. Nothing evicted silently. |

### Tests

Red before green, each on the property's assertion. Non-vacuity by mutation is
named per test.

- `packages/docker/test/preview-target.test.ts`: accept 127.0.0.1 / 0.0.0.0 /
  `""`; refuse ::1-only, udp, unpublished, not running, `NetworkMode:"host"`,
  `Privileged`, a `docker.sock` mount (source and destination), a non-local
  endpoint. *Mutation:* drop the privileged check → its case fails.
- `packages/core/test/permission*.test.ts`: `container_preview` is not
  `autoApproves`, is `onceOnlyAsk`, and is `externalMayAnswer === false`.
- `packages/tools/test/container-preview.test.ts`: the model passes `container:"safe-app"`
  while the fake resolver returns `Name:"/admin"`, `Image:"evil:1"` → the
  ask's title/detail contain the engine's values and not the model's string.
  Decline → `add` is never called. Refusal → no ask at all.
- `packages/daemon/test/preview-tunnels.test.ts` (real loopback server the test
  binds itself, `port: 0`, kept bound — §9 ok): bytes both ways; window: with
  no ack, the upstream is paused at ≤ window (`until`, never a sleep); a non-HTTP
  first line → closed, upstream received 0 bytes; WebSocket upgrade request
  passes; `PRI * HTTP/2.0` refused.
- `packages/daemon/test/connection-preview.test.ts` (existing connection test
  fakes + a fake resolver): token principal → `Unauthorized`; not open →
  `UnknownSession`; re-resolve: the 2nd connect after the fake engine says "not running" →
  `PreviewGone` + a `previews` update without the row; a port change → dials the new
  port; `Connection.close()` → the upstream socket closes; session close →
  tunnels closed + list cleared. *Mutation:* cache the first resolve → the
  re-resolve test fails.
- No-persistence: after `add`, the persister's captured state has no previews
  (`session-persister` test seam).
- Wiring: serve with `previews.enabled` offers `container_preview`. Disabled,
  the worker and a pod daemon (`serve --stdio`) do not. Sub-agents never.
- Protocol: `json-schema.test.ts` drift (regenerate via the test's command),
  `UPDATE_CLASS` exhaustiveness, `client/mapping` round-trip for `previews`.

**Validation (live, opt-in):** on the owner's serve with Docker,
`docker run -d -p 127.0.0.1:8080:80 nginx` → prompt the model "show it on my
phone". Check that the ask shows the engine facts. Then drive `preview_connect` + an HTTP GET
from a scratch client in `.tentacle/tmp/container-apps-devices/` using the
device test key → nginx's page. `docker stop` → the next connect gets `PreviewGone`.

### Notes / debt

- **S2 (phone, next branch), outline only, to be planned in its own doc:** a dumb
  Expo native module `tentacle-loopback` (Swift `NWListener` on `127.0.0.1:0`,
  accept/data/close events, write/close/stop methods; the
  `apps/mobile/modules/` pattern). A pure `preview-gate.ts`: a per-viewer
  128-bit secret; bootstrap `GET /__tentacle/<secret>` → `Set-Cookie` HttpOnly
  SameSite=Strict + 302 `/`; every new TCP connection's FIRST request must carry
  the cookie, else 403 + close. This stops other apps on the phone from riding the
  listener, which listens only while the viewer is foreground. A WebView viewer
  (thin top bar: name · port · Stop; no rounded inset cards; thin icons), a
  session chip, and a hub entry `previews` (`HubEntryId`, `hub-actions.ts:12-28`)
  with a count badge, dimmed + inline label when empty (UI empty-action
  standard). Mockups ≥ 2 variants first. It flips `previews.enabled` default and
  writes the changelog fragment.
- Public exposure (capability link through the relay) stays a later task after
  `feat/a2a-relay` (owner answer 7).
- Not done: IPv6-only bindings, raw TCP, HTTP/2, persisting previews across
  restarts, a model stop tool.

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Before editing.** Capability missing: the Repro `rg` → `0`. Load-bearing check
re-run (`.tentacle/tmp/container-apps-devices/pause.ts`): `while paused, received
0 extra bytes` / `total 4194304 bun 1.4.3`. Passes; `peer.ts` still dispatches
frames synchronously and `device-accept.ts` builds the one `Connection`.

**As built (plan order), all slices done, uncommitted.**

1. protocol: `preview.ts`, 2 methods, 3 notifications, `previews` update
   (display), `SnapshotResult.previews`, error codes; `protocol.json` regenerated.
   No `protocol.d/` note (all additive).
2. core: kind `container_preview` (3 exclusion sites), `previews.ts`.
3. docker: typed inspect fields, pure `preview-target.ts`.
4. tools `container-preview.ts`; sub-agent filter (both lists).
5. daemon: `preview-tunnels.ts`, `session-previews.ts`, `hosted-session.ts`,
   `session-host.ts`, `connection.ts`, `external/asks.ts`.
6. client: `permission-router.ts`, `mapping.ts`, `remote-session.ts` (listed
   with the other session-level updates).
7. config `previews.enabled` (default off; README table via `docs:config`);
   cli `preview-resolver.ts`, `serve.ts`, `wiring.ts`.
8. labels in `tui/permission-ui.ts` and `mobile/permission-sheet.ts`.

**Drift from Implementation.**

- `SnapshotResult.previews`, not `OpenResult.previews` (plan fixed above).
- The per-session list is its own module `session-previews.ts` (like
  `session-apps.ts`); `hosted-session.ts` only wires it.
- Second error code `PreviewUnavailable` (-32022) beside `PreviewGone` (-32021),
  for "failed, preview kept".
- Stricter than written: an upstream that speaks before the request line is
  closed; a container string outside the engines' name rule never reaches the
  engine; an inspect without `HostConfig` is refused; a re-resolve must answer
  the recorded id AND port. Only a 404 or a pure refusal removes a row; any other
  inspect/endpoint error is transient (kept).
- `previewTargetOf` takes one object (it needs `engine` too).
- **Changelog:** the header says none in S1, the executor brief asked for one
  fragment: `changelog.d/container-apps-devices.added.md` (says off by default,
  no phone viewer yet). S2 edits it instead of adding a second; delete it if S1
  should stay silent.

**Red before green.** Shown failing on assertions first: core (3 fail),
`preview-target` against a stub (17), tool (9), sub-agent (2), tunnels (14),
client (2), config (3), cli (7), TUI label (1). NOT shown first: the protocol
wire test (written after the schemas) and `connection-preview.test.ts` (covered
by the mutations below); the mobile label was shown red by disabling its branch.

**Mutations (each run, then reverted).**

```
preview-target: privileged check off        → (fail) refused > privileged            16 pass 1 fail
tunnels: credit not counted                 → (fail) no ack… / over-ack…            14 pass 2 fail
tunnels: HTTP reject ignored                → (fail) not HTTP/1 first               15 pass 1 fail
session-previews: cache the first resolve   → (fail) a changed host port is dialled 18 pass 1 fail
connection: device check off for the token  → (fail) a token principal → Unauthorized 18 pass 1 fail
connection: no tunnels.closeAll()           → (fail) Connection.close()             18 pass 1 fail
hosted-session: no previews.close()         → (fail) session close                  18 pass 1 fail
mobile: preview branch off                  → (fail) a preview sheet offers…         8 pass 1 fail
```

**Runs.** daemon + protocol + docker + config + the touched files: `3333 pass, 2
skip, 0 fail`. `packages/cli` + `packages/client`: `4073 pass, 2 skip, 1 fail` —
`chart-args-roundtrip` cannot resolve `@tentacle/core` from `apps/mobile` (mobile
deps are not installed in this worktree); it and both mobile test files pass with
a scratch resolver preload (`.tentacle/tmp/…/mobile-shim.ts`). `biome check` on
the changed packages: clean. Typecheck and the full gate: NOT run (the
orchestrator's script).

**Not verified.** The live Docker/Podman validation. For the security review
(left as the plan decided them): OD4 does not catch a parent-directory mount that
contains the socket (`-v /var/run:/x`, `-v /:/host`), nor `CapAdd`/`PidMode:host`;
`session/detach` closes no tunnel; a finished upstream whose phone stops acking
holds its slot until the preview or the link ends; approving the same
container+port twice makes two rows.

## Review

*(empty until reviewed — mandatory fresh-context Opus security review: red-team
OD3/OD4/OD5, the re-resolve, the window and the HTTP/1 gate)*
