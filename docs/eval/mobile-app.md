# eval/mobile-app — the tentacle mobile app

> **Status:** decided — all 21 owner decisions taken (2026-10-23); promote task by task in the order of decision 21
> **Branch:** none (an `eval` is committed directly to `main`, AGENTS §10)
> **Type:** eval → feat (19 tasks + TestFlight, see decision 21) · **Size:** L → split · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-23*

**Question being decided:** what the mobile client of a `tentacle serve`
daemon is (stack, connectivity, auth, session UX, notifications, scope),
decided up front so the build does not have to be reworked to fit the scope.
Owner goal (2026-10-23): "only the best in performance / robustness / UX".

Follows the v2 re-attach work (`docs/eval/session-reattach.md`, children 1–8b
done) and absorbs the open questions of `docs/eval/session-handoff.md`.

**In one paragraph.** An iOS-first React Native (Expo) app, iPhone + iPad,
iOS 26 minimum, native iOS UI with a custom transcript, reusing the TS
client/protocol packages from the monorepo. It reaches a per-project
`tentacle serve` over any of four paths (tentacle.so relay by default,
Tailscale, cloudflared, own domain, or a custom relay), always inside an
end-to-end encrypted channel; the phone is paired once per computer by QR with
confirmation on the computer, and projects appear by themselves. Every client
is a view of the session (terminal → phone → terminal, nothing lost); leaving
detaches, idle sessions archive and are deleted only by hand. v1 includes
end-to-end encrypted push with Approve / Deny under Face ID and a Live
Activity. Open source (MIT), no third-party telemetry, TestFlight first and
App Store-ready.

**Repro (2026-10-23): the TS client is portable off Bun/Node.**
From `.tentacle/tmp/mobile-portability/`:

```
$ bun build packages/client/src/index.ts --target=browser --outdir .tentacle/tmp/mobile-portability/out
Bundled 41 modules in 18ms
  index.js  197.38 KB  (entry point)
```

Modules bundled: `packages/client/src` (10), `packages/protocol/src` (11),
`packages/core/src` (2), `packages/transport/src` (2), zod. A search of the
bundle for `node:` / `Bun.` / `process.` finds nothing. The only platform
hooks: `crypto.randomUUID` (2×, needs a polyfill on React Native) and
`new WebSocket(url, {headers})` in `ws-channel.ts` (React Native's signature is
`(url, protocols, {headers})` → the mobile app brings its own `DuplexChannel`,
the "a new target adds only a transport" shape, AGENTS §7).

### Owner decisions

1. **Platform: iOS first, React Native (Expo).** iPhone only for now; iPad
   compatibility from the start if it comes cheap (owner, 2026-10-23).
   Why RN over Swift: the re-attach / seq / dedupe / resync logic stays ONE
   TypeScript implementation (verified portable above), so a protocol change
   does not need a Swift port; native-only surfaces (notification actions,
   Live Activity) are written in Swift as Expo modules. Android stays open
   (shared UI and logic; extra work only in push and testing), not in v1.
   iPad: adaptive layout from v1 (session list + transcript side by side on
   wide screens).
2. **Connectivity: four paths, one security model** (owner, 2026-10-23).
   - **Paths:** the tentacle.so relay (default, zero configuration), Tailscale,
     cloudflared, an own domain; plus a **custom relay** (the relay is a small
     open-source Bun service in the repo, self-hostable by anyone who does not
     trust tentacle.so). To the app every path is the same thing: a `wss://`
     URL with a publicly valid certificate (no self-signed, no pinning: iOS ATS).
   - **Relay shape:** the daemon dials OUT to the relay and registers; the relay
     assigns `wss://<relay>/d/<daemon-id>` and splices phone ↔ daemon bytes.
     No open port, works behind any NAT.
   - **The link addresses, it never authorises.** One address per daemon, not
     per session (sessions are listed in the app via `session/list`). Access is
     a per-device key created at pairing, revocable on the daemon. A secret URL
     leaks (logs, history, screenshots) and would be a shell on the machine.
   - **End-to-end encryption on every path.** A secure channel (Noise
     handshake, keys exchanged via the pairing QR) runs inside the tunnel, so
     the relay, Cloudflare or any TLS terminator sees only opaque bytes (which
     daemon, how many bytes, when). In code it is one more transport: a
     `DuplexChannel` wrapping another (AGENTS §7).
   - **Robustness:** the app keeps several addresses per daemon and tries the
     direct one first (Tailscale / LAN), the relay as fallback.
   - **One service, two uses:** the same relay later carries APNs push.
   - Cost accepted: tentacle.so becomes a service to keep up; the other paths
     stay available so a relay outage is not a total outage. Hosting (same
     Hetzner box as the site, or separate) — open, decided with push.
3. **Pairing** (owner, 2026-10-23).
   - `tentacle pair` on the daemon's host prints a QR (+ a text code to paste,
     for iPad / no camera) carrying the daemon id + public key, the known
     addresses, and a one-time pairing code (5 min, single use). The daemon's
     master token is never in it.
   - The app generates its own device key (Keychain, this-device-only: no
     iCloud backup, no migration) and sends it with a device name.
   - **Confirmation on the daemon:** `tentacle pair` asks
     "Add 'iPhone di Gabriel'? [y/N]" — a photographed QR alone is not enough.
   - `tentacle devices` lists devices (+ last seen); `tentacle devices revoke
     <name>` removes the key and closes that device's live connections at once.
   - One app, many daemons (each pairing adds a host).
   - Addresses may change after pairing: the daemon sends its current list on
     connect, no re-pairing.
4. **Session lifetime** (owner, 2026-10-23). Answers handoff Q2/Q7 and gap G5.
   - **Leaving detaches, never closes:** closing the app, quitting the TUI and
     losing the network are the same — the session, a running turn and
     background jobs keep going; the phone re-attaches as soon as it is back
     online. Accepted: a turn left running keeps spending tokens.
   - **Ending is explicit:** "End session" in the app, `/close` in the TUI;
     `/clear` = close + new.
   - **Idle TTL archives, never deletes.** Today the idle reaper closes the
     session AND deletes its record (`daemon/src/session-host.ts:162`,
     `persister.remove`). New: after the TTL the daemon unloads it from memory,
     stops its background jobs, keeps the record on disk as *archived*; it is
     listed as archived in app and TUI, and opening it reloads it with full
     history. The `--max-detached-sessions` eviction archives too.
   - **TTL configurable, including infinite:** extend the existing
     `serve --session-ttl 24h` (durations already parsed) with `never`, plus a
     way to change it on a running daemon — exact shape decided in
     Implementation.
   - **Deletion is manual only** ("Delete" in app / TUI); no automatic purge
     of archived sessions.
5. **Every client is a view of the SESSION** (owner, 2026-10-23: "everyone
   sees everything, exactly; terminal → mobile → terminal without losing
   anything, smoothly"). Answers handoff Q3/Q4/Q5, gaps G3/G4.
   - Opening an existing session shows its full history at once, then live
     updates. A turn started on any device renders live on every attached
     device exactly like an own turn (prompt, streamed output, tools).
   - A running turn belongs to everyone: any device can cancel or steer it.
   - A permission request is shown on every attached device; the first answer
     wins (already built daemon-side) and the others close themselves.
   - No per-device label on messages in v1 (owner: not needed).
6. **One daemon per project, for now** (owner, 2026-10-23). Today a `serve`
   daemon works on ONE directory: a client-requested `cwd` is deliberately not
   honoured (`daemon/src/session-host.ts:5-7`, `protocol/src/session.ts:277`).
   That stays. A new session from the phone opens in that daemon's project.
   Kept open for later (one daemon per machine, many projects under declared
   roots) without reworking the app: the app's model is host → projects
   (one project per host today), and `session/list` entries carry the `cwd`.
7. **Pairing is per computer; projects appear by themselves** (owner,
   2026-10-23). Refines 3 under 6.
   - Paired device keys and the computer's identity live in a registry shared
     by every daemon of that computer (tentacle's config dir), not inside one
     daemon: one `tentacle pair` authorises the phone on every daemon of that
     computer, present and future; `tentacle devices revoke` revokes on all.
   - **Discovery:** every running daemon announces its running siblings on the
     same computer, inside the encrypted channel (so it works on every path).
     The app shows "MacBook" → its live projects; a new `tentacle serve`
     appears on the phone within seconds.
   - A project whose daemon is down is shown greyed out, its sessions still
     readable from the phone's cache.
8. **Push notifications** (owner, 2026-10-23).
   - **Permission request:** pushed only if no device answers within a grace
     period (default 30 s, configurable) — at the desk you answer and the
     phone stays silent. Interruption level Time Sensitive.
   - **Turn finished / failed:** a quiet notification, grouped per session;
     not sent when the app is open on that session.
   - Nothing else (no per-message / per-tool push).
   - **Content end-to-end encrypted:** Apple and the relay carry an opaque
     blob; a Notification Service Extension decrypts it on the phone with the
     key exchanged at pairing (project, session, command / reply preview).
   - **Actions:** Approve (always requires Face ID), Deny (no Face ID), Open.
     If the background action cannot reach the daemon within iOS's few-second
     budget, the app opens on that request — never a silent loss.
9. **Relay hosting: the tentacle.so server for now; the domain is never
   hard-coded** (owner, 2026-10-23: a different domain, e.g. `tntcl.so`, may
   come later).
   - Runs on the site's box (142.132.169.22) behind Caddy, as the subdomain
     `relay.tentacle.so` so it can move to its own box with a DNS change.
   - The default relay URL is ONE value, overridable in the daemon's config
     (and by a custom relay). The app hard-codes no domain: it learns
     addresses from pairing and from the daemon's announcement on every
     connect (3), so a domain change reaches phones without an app update.
   - Development and tests run the relay locally; the server is needed only
     from TestFlight on.
10. **Distribution: TestFlight first, App Store-ready from day one** (owner,
    2026-10-23). Builds via EAS Build → TestFlight. Ready for public review
    without rework: privacy manifest, no private API, camera / notification
    permissions asked only when needed and explained, privacy policy hosted on
    the site. Account: personal Apple Developer (the owner opens it now);
    transferable to an organisation account if it is published as "tentacle".
11. **v1 scope** (owner, 2026-10-23).
    - **In v1:** QR pairing + computers → projects (auto-discovered); session
      list (live + archived), new / end / delete; live transcript (markdown,
      highlighted code blocks, tools collapsed with tap-to-expand, readable
      diffs for file edits); prompt, steer, cancel; in-app approvals with full
      detail; push with Approve / Deny (8); offline read from the last cache
      with a clear disconnected state; iPad adaptive layout; light/dark with
      the brand accent #06b6d4; dictation via the iOS keyboard.
    - **Live Activity / Dynamic Island in v1** (owner moved it in): lock
      screen + Dynamic Island show the running turn (current tool, elapsed),
      an approval waiting (with Approve / Deny), "done" for a few minutes.
      Updated via ActivityKit push through the same relay as notifications;
      a turn started elsewhere (app closed) starts it via push-to-start. The
      widget is a SwiftUI extension. iOS limit to handle: an activity lives at
      most 8 h.
    - **After v1, designed for (no rewrite):** attachments (the input bar is
      built for them), model / profile switch from the phone (v1 shows the
      model only), manual compaction, skills and MCP panels, cross-session
      search, Android.
12. **Minimum iOS 26 / iPadOS 26** (owner, 2026-10-23). iPhone 11 and later.
    Liquid Glass everywhere, no fallback styling branch; every v1 feature
    (push-to-start 17.2, interactive Live Activity 17) is available without a
    version check.
13. **Native iOS UI; only the conversation is custom** (owner, 2026-10-23).
    Navigation, bars, lists, context menus, sheets, buttons and settings are
    real iOS components (Expo Router native stack / tabs / headers, SwiftUI
    via `@expo/ui`): Liquid Glass, gestures, accessibility, Dynamic Type,
    keyboard and iPad adaptation behave like Apple's apps. Custom-drawn only
    where iOS has no equivalent: the transcript (messages, code, tools, diffs)
    and the input bar. Brand via the #06b6d4 accent, icons and the mascot —
    not by reinventing controls.
14. **App lock with Face ID** (owner, 2026-10-23).
    - On by default: reopening after > 5 min in background asks Face ID
      (setting: immediately / 5 min / 1 h / never).
    - Inside the unlocked app, approving asks nothing more.
    - From a notification or the Live Activity, Approve always asks Face ID (8).
    - While locked, content is hidden in the app switcher snapshot too.
    - Fallback to the device passcode when Face ID is unavailable or fails.
15. **Writing while a turn runs = exactly the TUI** (owner, 2026-10-23); same
    daemon methods, no mobile-only logic.
    - Send mid-turn queues a steer (`session/enqueue`), shown as a queued row
      (the TUI's spinner) until the agent takes it; then it moves into the
      transcript on every device.
    - "Send now" (shown only with a non-empty queue) = the TUI's
      `Ctrl+X Ctrl+S`: `session/send_now` (`docs/eval/send-now.md`).
    - Stop: the send button becomes ■ while a turn runs and the field is
      empty; no confirmation (as Esc).
    - A rejected enqueue (the turn ended just before) puts the text back in
      the field — never lost.
    - **Every device sees every device's queue.** Today the daemon only
      broadcasts a steer when it is injected (`steer`,
      `protocol/src/updates.ts:80`), not when it is queued → needs a new
      display update (queued / dequeued). Display class: additive, no
      `PROTOCOL_VERSION` bump (AGENTS §7).

16. **Writing offline** (owner, 2026-10-23).
    - The input stays enabled offline; the text is a per-session draft that
      survives an app kill.
    - Send while offline → the message is "waiting for network" (a queued row
      with its own icon), stored on the phone.
    - On reconnect the app re-syncs first. If the session did not change since
      the message was written (no new update, no running turn) it is sent
      automatically; otherwise the app shows what changed and the user picks:
      send, queue as steer, or discard. Never a blind send into a changed
      context.
    - A command already in flight when the link drops (prompt, approval,
      stop) is re-sent on reconnect with its idempotency key — executed once
      (existing v2 behaviour).

17. **Session titles: model-generated, renamable, one truth** (owner,
    2026-10-23). Today a title is the first user message truncated
    (`agent/src/session-store.ts:36`, `sessionTitle`) — unreadable in a phone
    list, a notification or the Live Activity.
    - After the first exchange the daemon asks the model, in background, for a
      3–6 word title in the language of the first message; on failure the
      current truncated title stays (never untitled). Optionally a cheaper
      model of the same provider, if configured.
    - Rename by hand in the app or the TUI (`/rename`); a user-chosen title is
      never overwritten.
    - The daemon owns the title; a change is broadcast to every attached
      device (list, notifications, Live Activity, TUI picker show the same).
18. **Open source: yes, same repo, same licence (MIT)** (owner, 2026-10-23).
    The E2E promise is only verifiable with open code; the relay is already
    self-hostable; the app imports workspace packages directly. Rules from the
    first commit: no secret in the repo (the APNs key lives only on the relay
    server, EAS / Apple credentials in their services, no token in
    `app.json`); the bundle id and icons stay the owner's. AGPL is an option
    for the relay only, if a closed hosted fork ever matters.

19. **No third-party telemetry** (owner, 2026-10-23). Crashes only via Apple
    (opted-in users → Xcode Organizer / TestFlight; TestFlight screenshot
    feedback). No Sentry / Firebase / analytics / tracking: privacy label "Data
    Not Collected". Settings → "Export logs" writes a local file (connection
    state, errors, timings — never conversation content or keys) that the
    user chooses to share. Sentry-like reporting stays a possible future
    opt-in.

20. **Testing: four levels** (owner, 2026-10-23).
    - Logic in pure TS modules (transcript view, offline outbox, notification
      rules incl. the grace period, project discovery, connection state) under
      `bun test`, inside `bun run check`; the app's typecheck is in `check` too
      (a protocol change that breaks mobile fails the gate).
    - Crypto: the Noise channel against the spec's published vectors; push
      encryption with cross-language JSON vectors (TS daemon encrypts, Swift
      NSE decrypts) — the place where the vectors deferred by 8a (R-Q3) do
      earn their keep; mutation tests (break key verification → must fail).
    - E2E on the iOS simulator (Maestro) against a real `tentacle serve`, a
      local relay and the repo's mock model server. Scenarios = the owner's
      requirements: terminal → phone → terminal identical; phone dies on a
      pending approval, returns hours later, Approve / Deny work; offline send;
      `devices revoke` closes at once; push and Live Activity via
      `xcrun simctl push`. Needs macOS + Xcode → separate `bun run e2e:mobile`,
      **mandatory before merging a mobile task**.
    - A short real-iPhone checklist before every TestFlight build (real push,
      Face ID, Dynamic Island).

21. **Task order** (owner, 2026-10-23). One code task at a time (AGENTS §10),
    each its own branch + doc, promoted from this eval when it starts. Most
    touch the protocol, the session lifecycle or security → load-bearing,
    fresh-context Review mandatory. Principle: kill the biggest risk first,
    then daemon foundations, then a usable app on the direct paths before the
    relay (to the app the relay is just one more address).

    | # | Task | Size · Blast |
    |---|---|---|
    | **Phase 0 — risk** | | |
    | 0 | Spike: Expo app in the monorepo (Metro + Bun workspaces) connects to `serve` with the TS client | S · contained |
    | **Phase 1 — daemon foundations** | | |
    | 1 | `session/list` (title, cwd, updatedAt, running, attached, archived) | M · load-bearing |
    | 2 | Idle TTL archives instead of deleting; `--session-ttl never`; explicit delete | M · load-bearing |
    | 3 | Model-generated titles + `/rename`, broadcast | M · load-bearing |
    | 4 | `send_now` (`docs/eval/send-now.md`, its own A/B/C split) | L · load-bearing |
    | 5 | Queued-steer broadcast (display update) | S · load-bearing |
    | **Phase 2 — handoff, TUI side** | | |
    | 6 | TUI renders foreign turns; eager open with full history | L · load-bearing |
    | 7 | `connect`: quit detaches, `--resume`, `/sessions`, `/close` | M · cross-module |
    | **Phase 3 — security** | | |
    | 8 | End-to-end encrypted channel (Noise `DuplexChannel` wrapper) | M · load-bearing |
    | 9 | `tentacle pair` (QR + confirm), per-computer device registry, `devices` / `revoke` | L · load-bearing |
    | 10 | Sibling discovery + address announcement | M · load-bearing |
    | **Phase 4 — the app, usable on direct paths** | | |
    | 11 | Shell: pairing, computers → projects, session list; Maestro E2E harness | M–L · contained |
    | 12 | Live transcript (markdown, code, tools, diffs) | L · contained |
    | 13 | Compose: prompt, steer, send now, stop, approvals, offline outbox | M · cross-module |
    | 14 | Face ID lock, switcher privacy, log export | S · contained |
    | **Phase 5 — relay** | | |
    | 15 | Relay service (`relay.tentacle.so`, configurable), daemon dial-out, deploy | L · load-bearing |
    | **Phase 6 — push & Live Activity** | | |
    | 16 | E2E push via the relay (APNs) + daemon grace rule | L · load-bearing |
    | 17 | App notifications: NSE decrypt, Approve (Face ID) / Deny / Open | M · cross-module |
    | 18 | Live Activity / Dynamic Island (push-to-start, updates) | L · cross-module |
    | **Phase 7** | First TestFlight build (real-iPhone checklist) | — |

    Ordering choices confirmed: the TUI handoff (phase 2) lands before the app,
    so terminal → phone → terminal works as soon as the app exists; the relay
    comes after the app, which is tried first over Tailscale.

### Owner decisions after the eval was committed

- **Bundle id: `so.tentacle.app`** (owner, 2026-10-23). Reverse-DNS of the
  owned `tentacle.so`; not tied to the relay's domain (a later `tntcl.so`
  changes nothing). Fixed before task 11; the spike keeps
  `so.tentacle.spike`.
- **`serve` rejects any `Origin` header** (`daemon/src/ws-server.ts:116-121`),
  and iOS's WebSocket always sends one (= the address dialled) — found by task
  0. The policy is decided in task 9; recommendation: connections
  authenticated by a device key (Noise, task 8/9) are exempt from the Origin
  check, since a web page cannot hold that key.
- **Task 8 plan** (approved 2026-10-23): Noise_IK_25519_ChaChaPoly_SHA256 on
  `@noble/*`; the official snow / cacophony vectors are a blocking first step
  (decision 20's "spec vectors" — the Noise spec publishes none).
- **Task 1 plan** (approved 2026-10-23): sessions ordered by the last
  CONVERSATION change (turn / compaction end), never by open / view / close;
  pagination from v1; unreadable records hidden.

### Dependencies (must land before / with the app)

- **`send_now`** — `docs/eval/send-now.md` (decided, not built): the app's
  "Send now" needs `session/send_now` (15).
- **Queued-steer broadcast** — new display update (15).
- **Session handoff** — `docs/eval/session-handoff.md`: Q2/Q7 answered by 4,
  Q3/Q4/Q5 by 5, Q6 by 3/7, Q1 and the Q8 split by 21 (tasks 1, 6, 7).

## Implementation

## Execution

## Review

*— claude-opus-5-5, 2026-10-23*

**Verdict: decided — promote task 0 (spike) first.** All 21 questions answered
by the owner one at a time (2026-10-23); the recommendations were accepted
except where the owner chose otherwise: one daemon per project (6, not one
per machine), relay on the site's box (9, not a dedicated one), iOS 26 minimum
(12, not 18), Live Activity in v1 (11), no automatic deletion of archived
sessions (4).

What holds, verified: the TS client bundles off Bun/Node (Repro above); a
client `cwd` is not honoured (`session-host.ts:5-7`); the idle reaper deletes
the record (`session-host.ts:162`); only an injected steer is broadcast
(`updates.ts:80`); titles are the first message truncated
(`session-store.ts:36`).

Not verified yet, and where each is settled:
- Metro resolving the Bun workspace layout (`node_modules/.bun`) and the TS
  client running under Hermes on a device → task 0. If it fails, decision 1 is
  reopened before anything else.
- What `RemoteClient`'s constructor (`ModelProvider`, `PermissionBroker`)
  requires of a thin client that serves no model → task 0 / 11.
- iOS background budget for a notification action to reach the daemon through
  the relay (8 has the fallback: open the app) → task 17.
- Live Activity 8 h cap vs long turns → task 18.

Risk to watch: most tasks are load-bearing (protocol, session lifecycle,
auth); the per-task fresh-context Review is not optional.
