# feat/mobile-spike — Expo app in the monorepo talks to `serve` through the TS client

> **Status:** execution done (plan approved by the owner 2026-10-23); awaiting Review
> **Branch:** `feat/mobile-spike`
> **Type:** feat · **Size:** M · **Blast:** cross-module · **Suited:** strong model executes (native toolchain + judgment calls); fresh-context Review recommended (lockfile / gate / CI change)

## Context

*— claude-opus-5-5, 2026-10-23*

Task 0 of `docs/eval/mobile-app.md` (decision 21, row 0). The eval chose React
Native + Expo **because** the TS client and protocol packages can be reused
as they are (decision 1), and left two things unverified (eval, Review: "Not verified
yet"): Metro resolving the Bun workspace layout, and the TS client running
under Hermes. If either fails, decision 1 is reopened before anything else is
built. This spike settles that. It is **not** task 11 (shell, pairing,
navigation, Maestro): one bare screen, no styling, no product logic.

**Acceptance (from the brief, refined by the findings below):**
- `apps/mobile`: an Expo app (dev build via `expo-dev-client`, not Expo Go;
  New Architecture; Hermes; iOS deployment target 26.0, decision 12) inside
  the monorepo. It imports `@tentacle/client`, `@tentacle/core`,
  `@tentacle/protocol` and `@tentacle/transport` as workspace packages (no
  copies, no publishing).
- On the local iOS 26.5 simulator it connects to a real, **unmodified**
  `tentacle serve`. It uses the existing `WebSocketChannel` plus a React
  Native WebSocket constructor shim. It opens a session, sends one prompt to a
  mock OpenAI-compatible model server and renders the streamed reply.
- Evidence: a simulator screenshot, Metro/daemon logs, and the exact commands.
- The repo gate keeps the same meaning and stays green: `bun install`,
  `bun run check`. The TUI keeps working: `tentacle connect` against the same
  `serve`, the full `bun test`, and `bun run compile` + `--version`.

**Questions the spike answers.** Q-a: Metro with Bun's isolated layout. Q-b:
React 18 (TUI) and React 19 (Expo) side by side. Q-c: the client under Hermes.
Q-d: `RemoteClient` for a client that serves no model. Q-e: how the app fits
into the gate. Q-f is new (found while planning): the daemon's `Origin` gate
and an iOS client. Status after planning: **Q-a, Q-b, Q-d, Q-e answered** by
the Repro below. **Q-c** is answered statically (it compiles to Hermes
bytecode, async generators are lowered, and the polyfills are identified); its
runtime half needs the simulator. **Q-f** is proven from source; it needs one
empirical line on the simulator and **an owner decision** on the real fix.

**Repro (2026-10-23).** `.tentacle/tmp/mobile-spike/repro.sh` copies the
tracked tree to `.tentacle/tmp/mobile-spike/ws` (`git ls-files | rsync`), adds
a minimal `apps/mobile`, adds `"apps/*"` to `workspaces`, and runs `bun install`
**in the copy** (never at the repo root). It then checks resolution, the gate,
Metro, the CLI bundle, the release lock bump, native autolinking/prebuild and a
CI-style install. Versions are Expo SDK 58 (`expo@58.0.17`; its template
`expo-template-bare-minimum@58.0.26` pins `react 19.3.0`, `react-native 0.88.0`).
`react-native@0.88.0` peers `react ^19.3.0`. Bun 1.4.3, Node 25, Xcode 26.5.

The script, condensed to its decisive commands (the scaffold files are the
ones listed under *Files*, minus the channel/screen logic):

```bash
git ls-files -z | rsync -a --from0 --files-from=- ./ $W/          # copy tracked tree
# + apps/mobile/{package.json (no "version"),app.json,tsconfig.json,index.ts,polyfills.ts,App.tsx}
sed -i '' 's#"workspaces": \["packages/\*"\]#"workspaces": ["packages/*", "apps/*"]#' package.json
printf '\napps/mobile/ios/\napps/mobile/.expo/\n' >> .gitignore
bun install
readlink packages/tui/node_modules/react; readlink apps/mobile/node_modules/react   # + ink, reconciler, RN, expo peers
bun run typecheck; bunx biome check .; bun test
./node_modules/.bin/tsc -p apps/mobile
(cd apps/mobile && bunx expo export --platform ios)                                 # Metro + Hermes bytecode
(cd apps/mobile && bunx expo export --platform ios --no-bytecode --source-maps)     # inspect sourcemap
bun build packages/cli/src/main.ts --target=bun --outdir cli-out --external react-devtools-core
bun -e 'bumpBunLock(lock, "0.1.0", "0.1.1", 14)'                                    # scripts/release-plan.ts
(cd apps/mobile && bunx expo-modules-autolinking resolve --platform apple --json; bunx expo prebuild --platform ios --no-install)
bun install --frozen-lockfile --filter '!@tentacle/mobile'                          # CI-style
```

Output (verbatim):

```
## 1. install
528 packages installed [1082.00ms]
## 2. who gets which React (Q-b)
packages/tui/react      -> react@18.3.1
apps/mobile/react       -> react@19.3.0
ink@5.0.1+b215e95ac4c38807 react -> react@18.3.1
ink-spinner@5.0.0+3a7fea93f8e25f21 react -> react@18.3.1
react-reconciler@0.29.2+f4eacebf2041cd4f react -> react@18.3.1
react-native@0.88.0+20bbbbefde45c66a react -> react@19.3.0
expo@58.0.17+36d3a17ce10ae4ac react -> react@19.3.0
expo-modules-core@58.0.24+20bbbbefde45c66a react -> react@19.3.0
hidden hoist react       -> react@19.3.0
hidden hoist @types/react -> react@18.3.12
## 3. lockfile: tui React entries
        "react": "19.3.0",
        "react": "18.3.1",
    "react": ["react@19.3.0", "", {}, "sha512-E8LUcbtBWt20bbl2YoHfx4ZDBdxVTfOKtC
    "@tentacle/mobile/@types/react": ["@types/react@19.3.0", "", { "dependencies
    "@tentacle/tui/react": ["react@18.3.1", "", { "dependencies": { "loose-envif
    "react-reconciler/react": ["react@18.3.1", "", { "dependencies": { "loose-en
## 4. gate in the copy
typecheck exit 0
Checked 399 files in 109ms. No fixes applied.
 1976 pass
 2 skip
 0 fail
Ran 1978 tests across 164 files. [79.21s]
## 5. mobile typecheck (tsc -p apps/mobile)
exit 0
React 18 types loaded: 0
## 6. Metro (Q-a): iOS bundle, Hermes bytecode, then plain JS + sourcemap
iOS Bundled 1769ms apps/mobile/index.ts (669 modules)
_expo/static/js/ios/index-eb3c4689f661bcf2bb8ee7b4ebdcb7f9.hbc (1.8MB)
iOS Bundled 247ms apps/mobile/index.ts (648 modules)
react copies: [ 'react@19.3.0' ] react-native: [ 'react-native@0.88.0' ] zod: [ 'zod@3.23.8' ]
workspace sources (by realpath): client,protocol,core,transport 40 files
for-await left in bundle: 0; _asyncIterator helper: 1
## 7. CLI bundle (release binary input) embeds: ReactVersion = "18.3.1"
## 8. release lock bump (scripts/release.ts:105 expects 14)
unversioned app: ok
app at 0.1.0: FAIL bun.lock: found 15 workspace versions at 0.1.0, expected 14
## 9. native: autolinking + prebuild (no pods)
expo modules: @expo/dom-webview @expo/log-box expo expo-asset expo-constants expo-crypto expo-dev-client expo-dev-launcher expo-dev-menu expo-dev-menu-interface expo-file-system expo-font expo-json-utils expo-keep-awake expo-manifests expo-modules-core expo-modules-jsi expo-updates-interface
prebuild exit 0
app target IPHONEOS_DEPLOYMENT_TARGET: 2 configs at 26.0
ATS NSAllowsLocalNetworking: 1
biome after prebuild (root .gitignore covers ios/): Checked 399 files in 96ms. No fixes applied.
## 10. CI-style install without the app
107 packages installed [58.00ms]
store entries: 108, size:  75M; tui react -> react@18.3.1
```

Two side checks, run once in the same copy and not part of `repro.sh`:
- Without the `paths` pin in `apps/mobile/tsconfig.json`, `tsc --explainFiles`
  shows that `expo/build/launch/registerRootComponent.d.ts` imports `react` →
  `@types+react@18.3.12`. Expo's `.d.ts` has no `@types/react` sibling link,
  so it falls through to the hidden hoist. Both React 18 and React 19 types
  then load.
- With `"types": []`, the mobile typecheck fails with 5 errors, all in
  `packages/agent/src/session-store.ts`: `node:crypto`, `node:fs`,
  `node:fs/promises`, `node:path` and `Bun`. The cause is the type-only import
  `@tentacle/agent` in `client/src/mapping.ts:10`. A nested
  `apps/mobile/.gitignore` is **not** honoured by Biome 1.9.4: a junk
  `apps/mobile/ios/junk.ts` was linted until the root `.gitignore` listed it.
- Store size: 79 MB with 113 entries today → 405 MB with 529 entries with the
  app. `bun pm untrusted` lists only the existing `@biomejs/biome` postinstall,
  so Expo/RN add no lifecycle scripts.

**Q-f source evidence (static).** RN 0.88 iOS WebSockets go through SocketRocket
(`react-native/React/CoreModules/RCTWebSocketModule.mm:152`,
`[[SRWebSocket alloc] initWithURLRequest:…]`). The pinned SocketRocket version
is 0.7.1 (`react-native/scripts/cocoapods/helpers.rb:45-46`). Its
`SRHTTPConnectMessage.m` always sets
`Origin: SRURLOrigin(url)`, and then applies `request.allHTTPHeaderFields`,
which can **replace** that value but not remove it. So every RN iOS
upgrade carries an `Origin` (e.g. `http://127.0.0.1:4000`).

## Implementation

*— claude-opus-5-5, 2026-10-23*

### Load-bearing assumption

**React 19 (Expo) and React 18.3.1 (TUI/Ink 5) live in one Bun isolated-linker
workspace, and each consumer resolves exactly its own copy: the TUI (runtime,
tests, compiled binary) keeps 18.3.1, and Metro bundles exactly one React,
19.3.0.** Proven by the Repro:
- Runtime links: TUI, `ink`, `ink-spinner` and `react-reconciler` → 18.3.1;
  `react-native`, `expo` and `expo-modules-core` → 19.3.0 (§2).
- Unchanged TUI graph: the same `ink@5.0.1+b215e95…` and
  `ink-spinner@5.0.0+3a7fea93…` peer-variant hashes as the live repo
  `node_modules/.bun`.
- Lockfile: TUI's React becomes a scoped `"@tentacle/tui/react": 18.3.1`
  entry (§3).
- Full suite green (§4).
- Metro bundle: one React, 19.3.0 (§6).
- CLI bundle: `ReactVersion = "18.3.1"` (§7).

The residual risk is the **hidden hoist flip**. `node_modules/.bun/node_modules/react`
moves from 18.3.1 (today) to 19.3.0 (§2). Only an *undeclared* (phantom) `react`
import would see it. None exists on the TUI path: the suite and the CLI bundle
prove it. The executor re-proves it with the real `bun run compile` + `--version`
and a live `tentacle connect`.

### Preconditions

- **One session path (AGENTS §7).** The app is one more frontend of the same
  `RemoteClient` ↔ `Connection` stack. It adds only a transport (a WebSocket
  constructor shim), no second session code path. `connect` already drives
  `RemoteClient` directly with a WebSocket factory
  (`cli/src/connect.ts:88-118`), and the app does the same.
- **No model on the client (Q-d).** `modelProvider` is optional
  (`client/src/remote-client.ts:252-261`). Without it, a daemon's
  `model/stream*` gets `MethodNotFound` (`remote-client.ts:1269-1272`,
  `1297-1302`), and a `serve` daemon runs its own provider anyway. `connect`
  already passes `undefined` (`connect.ts:113`). **No client change is needed.**
- **Single broker (AGENTS §7).** `PermissionBroker` is a concrete class in
  `@tentacle/core`. With no requester and no `holdUntilSet`, it defaults to
  `allowAll` (`core/src/permission.ts:107-110`), so the app must NOT use
  `new PermissionBroker()`. The spike builds ONE broker with an explicit,
  logged deny requester. A tool request in the spike is denied, never
  silently approved.
- **The transport seam exists (Q-c / RN signature).**
  `webSocketChannelFactory(url, options, deps)` takes an injectable
  `deps.WebSocket` constructor (`client/src/ws-channel.ts:172-198`). It calls
  it as `new Ctor(target, init)`, with `init = {headers}` and `?token=` on the
  URL (`ws-channel.ts:91-120`). RN's constructor is `(url, protocols, options)`
  (`react-native/Libraries/WebSocket/WebSocket.js:100-104`), so passing
  `init` straight through would treat it as the protocol list. A 5-line shim
  `(url, init) => new RNWebSocket(url, undefined, init)` is the whole adapter.
  `WebSocketChannel` needs only `send`/`close`/`addEventListener`
  (`ws-channel.ts:9-13`), and RN's `WebSocket extends EventTarget`
  (`WebSocket.js:78`) and dispatches `message`/`open`/`close`/`error`
  (`WebSocket.js:254-290`). **No new `DuplexChannel` class is needed.**
- **Hermes surface of the client closure (Q-c).** The Metro bundle (Repro §6)
  contains only `client`, `protocol`, `core`, `transport` and `zod@3.23.8`.
  The `@tentacle/agent` import is type-only (`client/src/mapping.ts:10`) and
  erased; `protocol/src/json-schema.ts` (`node:fs`) is not in the index and
  not bundled. Runtime APIs used:
  - `crypto.randomUUID` (`client/src/remote-session.ts:121,139`): Hermes has
    no `crypto`, so it is polyfilled from `expo-crypto`.
  - `new URL(url).searchParams.set` (`ws-channel.ts:99-103`): provided by
    Expo's winter runtime (`expo/src/winter/runtime.native.ts:16-18`,
    `whatwg-url-minimum`).
  - Async generators (`client/src/queue.ts:51`, `remote-session.ts:132,144`):
    lowered by Babel (Repro §6: 0 `for await` left), and
    `Symbol.asyncIterator` is polyfilled by Expo (`runtime.native.ts:33`).
  - `AbortController` (`transport/src/peer.ts:349`) and `queueMicrotask`
    (`transport/src/channel.ts:40`): RN globals.
  - `TextDecoder` appears only inside `transport/src/stream-channel.ts:33`,
    a function the app never calls.
- **Loopback serve without a token is allowed** (`daemon/src/ws-server.ts:178`).
  `serve` defaults are `127.0.0.1:4000`, and audit lines are printed
  (`cli/src/main.ts:362-381`). A token comes from `--token` or
  `TENTACLE_REMOTE_TOKEN` (`cli/src/flags.ts:353-364`).
- **Origin gate (Q-f).** Without an allow-list, the daemon rejects ANY
  `Origin` (`ws-server.ts:116-121`). That is the anti-CSRF/DNS-rebinding
  default for browsers. A rejection is `401` + audit `auth-failure /`
  (`ws-server.ts:207-209`). `serve` never passes `allowedOrigins`
  (`cli/src/serve.ts:177-186`, `ServeOptions` at `serve.ts:44-55` has no
  such field). Combined with SocketRocket's unconditional `Origin` (Context),
  **an RN iOS client cannot connect to an unmodified `serve`.**
- **The mock model server is a pattern, not a module.** The repo has no
  standalone one. The pattern is the inline OpenAI-compatible SSE `Bun.serve`
  of `cli/test/main.test.ts:11-13,37-40,49-56`, pointed at by
  `TENTACLE_MODEL_BASE_URL` / `TENTACLE_MODEL` / `TENTACLE_CONFIG_DIR`
  (`main.test.ts:67-70`).
- **Toolchain.** Xcode 26.5 is present, with the iOS 26.5 runtime and an
  iPhone 17 Pro simulator. **CocoaPods is NOT installed** (`pod not found`),
  and Expo 58's iOS template still uses a `Podfile`. Watchman is absent; Metro
  works without it (Repro §6).

### Design

**Shape.** `apps/mobile` is a new workspace (`"workspaces": ["packages/*", "apps/*"]`).
It uses Continuous Native Generation: `ios/` is generated by
`expo prebuild` / `expo run:ios` and **not committed**. Every native setting
comes from `app.json` + config plugins:
- `expo-build-properties` sets `ios.deploymentTarget: "26.0"`.
- Hermes is the template default (`Podfile.properties.json`
  `expo.jsEngine: hermes`).
- The New Architecture is the only architecture on RN 0.88.

Exact pins, matching repo style: `expo 58.0.17`, `react 19.3.0`,
`react-native 0.88.0`, `expo-dev-client 58.0.14`,
`expo-build-properties 58.0.11`, `expo-crypto 58.0.7`,
`@types/react 19.3.0` (dev). The app's `package.json` carries **no
`version`**: the app version lives in `app.json`, and a `version` breaks
`bun run release` (Repro §8).

No `metro.config.js`: Expo's default config resolved the workspace with zero
configuration (Repro §6). If the dev server (as opposed to `expo export`)
needs one, the executor adds the minimal `getDefaultConfig(__dirname)` and
records it as drift.

**Runtime flow (one screen, no styling).**
1. `index.ts` imports `./polyfills` first (`crypto.randomUUID` ← `expo-crypto`
   `randomUUID`, only if absent), then `registerRootComponent(App)`.
2. `src/rn-websocket.ts`, pure and React-free: `rnWebSocketCtor(RN)` returns a
   `WebSocketCtor` that calls `new RN(url, undefined, init)`. The `init` is
   forwarded as RN's options (`{headers}`; a `tls` key, never set here, is
   ignored by RN).
3. `src/spike.ts`, pure apart from the injected deps: `runSpike({ url, token,
   prompt, WebSocket, log, onText })`.
   - `dial = webSocketChannelFactory(url, token ? {token} : {}, {WebSocket})`;
     `channel = await dial()`.
   - `broker = new PermissionBroker(spikeDeny)`, where `spikeDeny` logs the
     request and returns `{allowed: false}`. It is the ONE broker.
   - `client = new RemoteClient(channel, broker, undefined, {channelFactory: dial, onError: log})`.
   - `await client.initialize()`; log the protocol version and daemon info.
   - `session = client.newSession(undefined, crypto.randomUUID())`.
   - `for await (const ev of session.send(prompt))`: `type === "text"` →
     `onText(delta)` with a timestamped log per delta (this shows streaming).
     Other types are logged.
   - `await client.closeSessions(); client.close()` (`connect.ts:134-135`).
   - It also logs runtime facts first, for Q-c: `typeof HermesInternal`,
     `global.RN$Bridgeless` (New Arch), `crypto.randomUUID()` shape and
     `URL.searchParams` round-trip.
4. `App.tsx` is a dumb renderer. On mount it calls `runSpike` with
   `url = process.env.EXPO_PUBLIC_TENTACLE_URL ?? "ws://127.0.0.1:4001"`,
   `token = process.env.EXPO_PUBLIC_TENTACLE_TOKEN`,
   `prompt = process.env.EXPO_PUBLIC_TENTACLE_PROMPT ?? "hello"`, and the
   global `WebSocket`. It renders a status line, the streamed text and the
   last error. The spike auto-runs, so no tapping is needed (there is no
   Maestro yet). Nothing secret is in the repo: the URL and token come from
   the environment at build time (decision 18).

**Q-f in the spike: a throwaway proxy, the daemon untouched.** The spike does
not change the daemon's security gate. The executor runs
`.tentacle/tmp/mobile-spike/strip-origin.ts`, a Bun TCP proxy:
- It listens on `127.0.0.1:4001` and buffers each connection's bytes up to
  the first `\r\n\r\n`.
- It drops the `Origin:` header line, logging its value: that line IS the Q-f
  evidence.
- It forwards the rest to `127.0.0.1:4000` and then pipes raw bytes both ways,
  closing both sides together.

Byte-level is chosen over a WebSocket-level proxy so the daemon sees the
phone's own frames and close codes. The real policy is an **owner decision**
(see Review notes / report), not this task:
- (a) a `serve --allow-origin` flag;
- (b) accept an `Origin` equal to one of the daemon's own advertised
  addresses;
- (c) exempt connections authenticated by a device key / the Noise handshake
  (tasks 8–9): a browser cannot complete that, so the Origin check is
  redundant there.

On the relay path (decision 2), the daemon dials *out*, so the phone's
`Origin` never reaches it. The question only concerns the direct paths
(Tailscale, LAN, cloudflared, own domain), i.e. task 11.

**Gate integration (Q-e), minimal for the spike.**
- `typecheck`: `"tsc --noEmit && tsc -p apps/mobile"`. The root `tsconfig.json`
  stays packages-only (`tsconfig.json:28-34`). The app needs its own React 19
  types, but the root forces `types: ["bun","react"]` with
  `@types/react 18.3.12` (`tsconfig.json:10`, `package.json:29`). Decision 20
  puts the app's typecheck in `check`; it costs about 0.7 s.
- `apps/mobile/tsconfig.json` extends `expo/tsconfig.base`, plus the repo's
  strict flags and `allowImportingTsExtensions`. It **pins `react` /
  `react/*` types to the app's own `@types/react` via `paths`**: without that,
  Expo's `.d.ts` pick up React 18 types through the hoist (Context). It sets
  `"types": ["bun"]` as a **stopgap** for the client's type-only
  `@tentacle/agent` import (Context). This is debt: it lets a `Bun.*` use in
  app code typecheck. Task 11 removes it (see Review follow-ups).
- Biome: app sources ARE linted (wanted). The root `.gitignore` adds
  `apps/mobile/ios/`, `apps/mobile/android/` and `apps/mobile/.expo/`. Biome
  1.9.4 ignores nested `.gitignore`s (Context) and uses the root one
  (`biome.json:3`).
- `bun test`: discovery already covers `apps/mobile/**/*.test.ts`, which is
  wanted for decision 20. The executor checks that the generated `ios/` (Pods)
  adds no test files: the file count stays at baseline + 1.
- CI (`.github/workflows/build.yml:52`): becomes
  `bun install --frozen-lockfile --filter '!@tentacle/mobile'`. The release
  binary keeps a 75 MB / 108-entry store instead of 405 MB / 529 (Repro §10)
  and does not depend on Expo installing on Linux runners.
  The executor proves `bun run compile` after that filtered install.
- `bun run release`: the app is unversioned (above); `scripts/release.ts:84`
  globs only `packages/*`, which stays correct.

**What task 11 finishes** (not this spike):
- Remove the `types: ["bun"]` stopgap.
- RN close-code classification.
- The Origin policy.
- A reusable mock model server + `bun run e2e:mobile` (Maestro).
- EAS config.
- Whether CNG stays viable alongside the Swift extensions of tasks 17–18
  (config plugins or local Expo modules).

### Files

In dependency order (no protocol, daemon, client, cli or tui source change):

1. `package.json`: `workspaces` += `"apps/*"`; `typecheck` += `&& tsc -p apps/mobile`.
2. `bun.lock`: regenerated by `bun install` (≈ +1 050 lines). Existing pins
   unchanged; TUI's React moves to a scoped key.
3. `.gitignore`: `apps/mobile/ios/`, `apps/mobile/android/`, `apps/mobile/.expo/`.
4. `.github/workflows/build.yml:52`: `--filter '!@tentacle/mobile'`.
5. `apps/mobile/package.json`, `app.json`, `tsconfig.json`, `index.ts`,
   `polyfills.ts`: as in the Repro, plus `"name": "@tentacle/mobile"` and no
   `version`.
6. `apps/mobile/src/rn-websocket.ts`: the constructor shim (pure).
7. `apps/mobile/src/spike.ts`: `runSpike` (injected deps; no React).
8. `apps/mobile/App.tsx`: the dumb screen.
9. `apps/mobile/test/rn-websocket.test.ts`: see Tests.
10. `docs/feat/mobile-spike.md`: Execution (evidence pasted).

Throwaway, under `.tentacle/tmp/mobile-spike/` (not committed; paste into
Execution): `mock-model.ts`, `strip-origin.ts`, `project/` (the `serve` cwd)
and `config/` (`TENTACLE_CONFIG_DIR`).
- `mock-model.ts` is `Bun.serve` on `:4100`. It answers any request with SSE
  text deltas `"Hello"`, `" from"`, `" the"`, `" mock"`, `" model."`, 250 ms
  apart, then `finish_reason: "stop"` and `[DONE]`, using the shape of
  `main.test.ts:11-13,37-40`.

### Failure modes

- **Origin rejected (Q-f).** A direct dial to `:4000` gets `401`, and the
  daemon prints `[daemon] auth-failure /`. The app sees `error` + `close 1006`
  (`WebSocket.js:284-290`). It converges by dialling through `strip-origin` on
  `:4001`. Step 7 below records both runs (red, then green).
- **RN classifies every upgrade failure as transient.** Bun reports a non-101
  as close 1002 (`ws-channel.ts:134-147`); RN reports 1006, so
  `classifyUpgradeFailure` says `unreachable`, never `unauthorized`
  (`ws-channel.ts:142-170`). Inside `RemoteClient`'s redial loop, a bad token
  would retry forever instead of stopping. The spike does not fix it (its
  first dial is outside the loop and surfaces the error). The executor logs
  the RN `error` event's `message`, to learn whether the HTTP status is
  available, as data for task 11.
- **Two Reacts at runtime ("Invalid hook call").** Already excluded for the
  export (Repro §6). The executor re-checks the dev-server bundle: the app
  renders, and no hook warning appears in the Metro log.
- **Hidden hoist flip breaks a phantom `react` import.** Covered by the full
  suite (Repro §4) and the CLI bundle (§7). The executor additionally runs
  `bun run compile && ./dist/tentacle --version` and a live
  `tentacle connect` against the spike's `serve` (TUI renders the same mock
  reply).
- **Type split (React 18 types in the app).** The `paths` pin; Repro §5 shows
  "React 18 types loaded: 0".
- **Release breaks.** The app is unversioned (Repro §8).
- **CI install bloat or a Linux install failure from RN/Expo.** The
  `--filter` (Repro §10).
- **Biome lints generated native code.** Root `.gitignore` entries; verified
  after `prebuild` (Repro §9).
- **`bun test` discovers files under `ios/Pods`.** The executor compares the
  file count after `pod install`. If it grew, add a root `bunfig.toml`
  `[test]` exclusion or move generation out of the tree, and record it as
  drift.
- **ATS blocks `ws://127.0.0.1`.** The generated `Info.plist` has
  `NSAllowsLocalNetworking: true` (Repro §9). The simulator shares the Mac's
  loopback.
- **Version skew.** The app and `serve` come from the same checkout, so they
  share the same `PROTOCOL_VERSION`. A skew fails at `initialize` with
  `VersionMismatch`, shown on screen.
- **A tool permission request arrives.** The mock replies with text only. If
  one does arrive, the single broker denies it, logs it, and the turn
  continues. It is never auto-approved.
- **A drop mid-stream.** Out of scope. `RemoteClient` re-dials with the
  `channelFactory`; the spike only logs link status.
- **Toolchain.** CocoaPods is missing, and installing it changes the system
  (`brew install cocoapods`): this needs the owner's OK. If `expo run:ios`
  fails on a Bun-layout path (pods resolving `react-native` through
  `node_modules/.bun`), that is a Q-a failure on the native side. The
  executor records the exact error and stops after two attempts (AGENTS §0);
  it does not hack around it.

### Tests

- `apps/mobile/test/rn-websocket.test.ts`, under `bun test` (no RN import; fake
  constructors). **Red first**: written before `rn-websocket.ts` exists, it fails
  on import.
  1. **Signature.** The shim calls the RN constructor as
     `(url, undefined, {headers: {Authorization: "Bearer t"}})`: protocols are
     `undefined` and the headers are under the 3rd argument. **Mutation**:
     make the shim pass `init` as the 2nd argument; the test must fail.
  2. **Through the real factory.** `webSocketChannelFactory("ws://h:1/", {token: "t"}, {WebSocket: rnWebSocketCtor(FakeRN)})`.
     The URL carries `?token=t` and the headers reach the 3rd argument. A
     dispatched `open` resolves a channel. A `MessageEvent("message", {data})`
     reaches `setOnMessage`, and a `close` fires `setOnClose` once. `FakeRN`
     extends the global `EventTarget` (RN's shape), which proves
     `WebSocketChannel` works with an EventTarget socket, not only Bun's.
  3. **Pre-open close.** A `close` with code 1006 before `open` rejects with a
     `ChannelError` of kind `unreachable` (`ws-channel.ts:223-233`). This pins
     today's behaviour for RN; task 11 may change it.
- **Evidence, not unit tests (the spike's real acceptance)**, each pasted into
  Execution:
  1. Baseline on `main`: `bun run check` (pass/skip counts, lint clean).
  2. After step 1 of Files plus `bun install`: the Repro §2 links and §3
     lockfile lines, from the real tree.
  3. `bun run check` green. `bun test` file count = baseline + 1.
  4. `bunx expo export --platform ios` + the sourcemap check (one React).
  5. `bun run compile && ./dist/tentacle --version`. Then a filtered,
     frozen install in a scratch copy, followed by `bun run compile`.
  6. `bunx expo run:ios --device "iPhone 17 Pro"` (after CocoaPods), with the
     env `EXPO_PUBLIC_TENTACLE_URL`, `…_TOKEN=spike-token`. Paste the Metro
     log runtime facts: Hermes present, `RN$Bridgeless === true`, the UUID
     shape, URL OK.
  7. In `project/`, start `TENTACLE_CONFIG_DIR=… TENTACLE_MODEL_BASE_URL=http://127.0.0.1:4100/v1 TENTACLE_MODEL=test bun <repo>/packages/cli/src/main.ts serve --token spike-token`
     with `mock-model.ts` running. Control first: `tentacle connect ws://127.0.0.1:4000 --token spike-token`
     shows "Hello from the mock model." (the TUI still works). Then:
     - **Red**: the app at `ws://127.0.0.1:4000` shows the error, and the
       daemon log has `auth-failure /`.
     - **Green**: the app at `ws://127.0.0.1:4001` (through `strip-origin`)
       shows the streamed reply. `strip-origin` logs the stripped `Origin`
       value, and the Metro log shows 5 text deltas about 250 ms apart.
     - `xcrun simctl io booted screenshot .tentacle/tmp/mobile-spike/green.png`
       (described in Execution; the PNG stays untracked).

## Execution

*— claude-opus-5-5, 2026-10-23*

**Outcome: the spike is green.** Q-a (Metro, *and* the native CocoaPods build,
with Bun's isolated layout), Q-b, Q-c (at runtime: Hermes, bridgeless), Q-d and
Q-e hold. Decision 1 stands. Q-f reproduced exactly as predicted: an
unmodified `serve` rejects the iOS client (red). The client works through the
throwaway `strip-origin` proxy (green). The real policy is still the owner's
decision (task 9/11). No protocol, daemon, client, cli or tui source was
touched.

### As built, in order

1. **Baseline (evidence 1)**: `bun run check` on the unchanged tree (only the
   untracked plan doc).
2. **Files 1, 3, 4**:
   - `package.json`: `workspaces` += `"apps/*"`; `typecheck` →
     `tsc --noEmit && tsc -p apps/mobile`.
   - `.gitignore` += `apps/mobile/{ios,android,.expo}/`.
   - `build.yml:52` → `bun install --frozen-lockfile --filter '!@tentacle/mobile'`.
     That is the only `bun install` in `.github/`.
3. **Files 5**: `apps/mobile/{package.json,app.json,tsconfig.json,index.ts,polyfills.ts}`.
   They are byte-identical to the Repro's, except `package.json`, which is
   reformatted to multi-line (same content, no `version`).
4. **Files 2**: `bun install` at the root (evidence 2).
5. **Tests, red first**: `apps/mobile/test/rn-websocket.test.ts` was written
   before the shim existed.
6. **Files 6**: `src/rn-websocket.ts`. Tests green, then the planned mutation
   (§9), then reverted.
7. **Files 7–8**: `src/spike.ts`, `App.tsx`; then `tsc -p apps/mobile` and
   `biome check --write apps/mobile` (formatting only).
8. Evidence 3 (gate), 4 (Metro export), 5 (compile; filtered frozen install).
9. `brew install cocoapods` (owner-approved: CocoaPods 1.17.0; it pulled
   Homebrew `ruby 4.0.9`). Then the mock model and `serve`, the TUI control,
   and evidence 6 (native build) and 7 (red, then green).
10. All processes stopped, the app terminated, the simulator shut down.
    Final `bun run check` with the generated `ios/` (Pods) still in the tree.

### Drift from Implementation

- **The shim is a class, not an arrow.** `(url, init) => new RN(…)` cannot be
  called with `new`, and the client calls `new Ctor(url, init)`. So
  `rnWebSocketCtor` returns a class whose constructor returns the RN socket.
  It needs a `biome-ignore lint/correctness/noConstructorReturn`. Without it,
  Biome reports 1 error (checked by deleting the comment).
- **`RNWebSocketCtor`'s `protocols` is typed `string | string[]`, not
  `unknown`.** With `unknown`, passing the global `WebSocket` failed
  `tsc -p apps/mobile` (TS2322: `unknown` is not assignable to
  `string | string[] | undefined`).
- **`spike.ts` wraps the constructor in `withDiagnostics`.** It logs RN's
  `error` (`message`) and `close` (`code`, `reason`) events. This is how the
  plan's "log the RN error event's message" gets done: the factory never
  exposes the socket. It is a second `noConstructorReturn` suppression,
  spike-only.
- **`App.tsx` shows the last log line as `status`.** It renders that plus
  `reply` and `error`, which is the plan's status/text/error.
- **Run mechanics.** The plan's single `expo run:ios` was split into three
  steps:
  - `expo run:ios --device "iPhone 17 Pro" --no-bundler` builds, installs and
    launches.
  - Metro runs separately with `expo start --dev-client --port 8081 --clear`,
    once per URL. `EXPO_PUBLIC_*` values are inlined at bundle time, so red
    (`:4000`) and green (`:4001`) each need their own Metro.
  - The app is opened with `xcrun simctl openurl booted "exp+tentacle://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"`.
  
  No `metro.config.js` was needed for the dev server either.
- **The TUI control drives the compiled `dist/tentacle`**, not
  `bun main.ts connect`. It runs in a pty (`tui-connect.py`, below), because
  Ink needs a TTY. This is the stronger check: it is the React-18 release
  binary.
- `apps/mobile/tsconfig.json`'s `include: ["**/*.ts","**/*.tsx"]` is kept.
  The generated `ios/` contains 0 `.ts/.tsx/.js` files and 0 test-pattern
  files, so neither `tsc` nor `bun test` sees it. The planned `bunfig.toml`
  fallback was not needed.

### Evidence

**1. Baseline (unchanged tree)**: `bun run check` → exit 0:
```
Checked 394 files in 98ms. No fixes applied.
 1976 pass
 2 skip
 0 fail
Ran 1978 tests across 164 files. [63.97s]
```

**2. After `workspaces` + `bun install` (real tree)**:
```
422 packages installed [1326.00ms]
bun.lock | 1182 +++++++-- (1108 insertions, 74 deletions)
packages/tui/react -> react@18.3.1
apps/mobile/react -> react@19.3.0
ink@5.0.1+b215e95ac4c38807 react -> react@18.3.1          ← what packages/tui links (unchanged hash)
ink-spinner@5.0.0+3a7fea93f8e25f21 react -> react@18.3.1  ← what packages/tui links (unchanged hash)
react-reconciler@0.29.2+f4eacebf2041cd4f react -> react@18.3.1
react-native@0.88.0+20bbbbefde45c66a react -> react@19.3.0
expo@58.0.17+36d3a17ce10ae4ac react -> react@19.3.0
expo-modules-core@58.0.24+20bbbbefde45c66a react -> react@19.3.0
hidden hoist react -> ../react@19.3.0/node_modules/react
bun.lock:1035  "react": ["react@19.3.0", …
bun.lock:1267  "@tentacle/mobile/@types/react": ["@types/react@19.3.0", …
bun.lock:1269  "@tentacle/tui/react": ["react@18.3.1", …
bun.lock:1345  "react-reconciler/react": ["react@18.3.1", …
```
The store also holds `ink@5.0.1+d2b1a511…` and `ink-spinner@5.0.0+07bf0410…`.
These are stale entries dated Oct 11, which no workspace links:
`readlink packages/tui/node_modules/ink{,-spinner}` gives the two hashes above.

**Unit test, red → green → mutation** (`bun test apps/mobile/test/rn-websocket.test.ts`):
```
# red (shim absent)
error: Cannot find module '../src/rn-websocket.ts' from '…/apps/mobile/test/rn-websocket.test.ts'
 0 pass  1 fail  1 error
# green
 3 pass  0 fail  8 expect() calls
# mutation: shim does `new RN(url, init)` (init as 2nd argument)
(fail) rnWebSocketCtor > calls RN as (url, undefined, init): no protocols, the headers under the 3rd argument
(fail) rnWebSocketCtor > through the real factory: ?token= on the URL, headers to RN's options, events reach the channel
 1 pass  2 fail
# reverted → 3 pass 0 fail
```
(Test 3, pre-open close 1006 → `unreachable`, does not depend on argument order,
so it stays green under this mutation. That is expected.)

**3. Gate after the change**: `bun run check` → exit 0. The same counts appear
again in the final run, with `apps/mobile/ios/` (Pods) present:
```
Checked 403 files in 100ms. No fixes applied.     (baseline 394 + 9 app files)
 1979 pass                                         (baseline 1976 + 3)
 2 skip                                            (the two opt-in skips)
 0 fail
Ran 1981 tests across 165 files.                   (baseline 164 + 1)
```
`tsc -p apps/mobile`: exit 0, about 0.8 s. React 18 types loaded
(`--explainFiles | grep -c types+react@18`): 0.

**4. Metro export** (`cd apps/mobile && bunx expo export --platform ios [--no-bytecode --source-maps] --output-dir …`):
```
iOS Bundled 1945ms apps/mobile/index.ts (671 modules)
_expo/static/js/ios/index-fe41d651220db2b41098507a24b93bcb.hbc (1.8MB)
iOS Bundled 308ms apps/mobile/index.ts (623 modules)
react copies: [ 'react@19.3.0' ] react-native: [ 'react-native@0.88.0' ] zod: [ 'zod@3.23.8' ]
workspace sources: apps/mobile,packages/client,packages/protocol,packages/core,packages/transport 45 files
for-await left: 0; _asyncIterator: 1
```

**5. Release binary + CI-style install**:
```
$ bun run compile && ./dist/tentacle --version
compiled → /Users/gmeghnag/tentacle/dist/tentacle
tentacle 0.1.0
$ strings dist/tentacle | grep -oE '…"18\.3\.1"…|…"19\.3\.0"…'
nalModuleStart(Error());var e="18.3.1",t=Symbol.     (React 18 only; no "19.3.0")
# scratch copy of tracked + new files (.tentacle/tmp/mobile-spike/ci-copy):
$ bun install --frozen-lockfile --filter '!@tentacle/mobile'
107 packages installed [50.00ms]                       (exit 0; bun.lock byte-identical after)
store entries: 108, size: 75M; tui react -> react@18.3.1; apps/mobile/node_modules: 0
$ bun run compile && ./dist/tentacle --version
tentacle 0.1.0
```

**6. Native build on the simulator**
(`CI=1 EXPO_PUBLIC_TENTACLE_URL=… EXPO_PUBLIC_TENTACLE_TOKEN=spike-token bunx expo run:ios --device "iPhone 17 Pro" --no-bundler`):
- It passed on the first attempt. `pod install` ran inside the Bun layout
  with no path problems.
- Result: `› Build Succeeded`, `› 0 error(s), and 4 warning(s)`. The warnings
  are Expo Dev Launcher's "Script has ambiguous dependencies" build phase and
  "ignoring duplicate libraries: '-lc++'".
- The app was installed and opened as `so.tentacle.spike`.
- Generated settings:
  - The app target has `IPHONEOS_DEPLOYMENT_TARGET = 26.0` ×2. The other 16.4
    pair is the pbxproj's project-level default.
  - `Podfile.properties.json` sets `"expo.jsEngine": "hermes"` and
    `"ios.deploymentTarget": "26.0"`.
  - `Info.plist` sets `NSAllowsLocalNetworking` `<true/>`.

Runtime facts from the Metro log (Q-c):
```
 LOG  [spike] runtime: typeof HermesInternal=object
 LOG  [spike] runtime: RN$Bridgeless=true
 LOG  [spike] runtime: crypto.randomUUID()=e02d6b2a-cbd3-43d6-bfaa-3655354b21a1 v4-shape=true
 LOG  [spike] runtime: URL.searchParams round-trip=ws://127.0.0.1:1/?token=a+b
```
Neither Metro log has an "Invalid hook call" warning or any other
warning/error. The only matches are "Bundler cache is empty" and the spike's
own red-run lines.

**7. End to end against an unmodified `serve`.** Started in
`.tentacle/tmp/mobile-spike/project/`:
```
bun .tentacle/tmp/mobile-spike/mock-model.ts                     # :4100
TENTACLE_CONFIG_DIR=…/mobile-spike/config TENTACLE_MODEL_BASE_URL=http://127.0.0.1:4100/v1 \
  TENTACLE_MODEL=test bun /Users/gmeghnag/tentacle/packages/cli/src/main.ts serve --token spike-token
→ daemon listening on ws://127.0.0.1:4000
```
- *Control (the TUI still works)*:
  `python3 tui-connect.py dist/tentacle connect ws://127.0.0.1:4000 --token spike-token`
  printed `mock reply on screen: True`. The streamed frames
  `⏺ Hello` → `⏺ Hello from` → … appear incrementally.
- *Red*: the app dials `ws://127.0.0.1:4000` directly.
  ```
   LOG  [spike] dialing ws://127.0.0.1:4000 (client protocol v10)
   LOG  [spike] ws error event: message=undefined
   LOG  [spike] ws close event: code=1006 reason="Received bad response code from server: 401."
   LOG  [spike] FAILED ChannelError: cannot reach the daemon (close 1006)
  daemon: [daemon] connection-open / [daemon] connection-close / [daemon] auth-failure /
  ```
- *Green*: the app dials `ws://127.0.0.1:4001` (`strip-origin`), with the same
  token and the same daemon.
  ```
   LOG  [spike] dialing ws://127.0.0.1:4001 (client protocol v10)
   LOG  [spike] socket open
   LOG  [spike] initialized: daemon protocol v10, capabilities={"tools":true,"permissions":true}, skills=1
   LOG  [spike] prompt: "hello"
   LOG  [spike] text delta @1792746396658: "Hello"
   LOG  [spike] text delta @1792746396909: " from"
   LOG  [spike] text delta @1792746397161: " the"
   LOG  [spike] text delta @1792746397412: " mock"
   LOG  [spike] text delta @1792746397663: " model."
   LOG  [spike] event: turn_end
   LOG  [spike] turn done
   LOG  [spike] closed
   LOG  [spike] ws close event: code=1000 reason=""
  strip-origin: stripped "Origin: http://127.0.0.1:4001" / request line: GET /?token=spike-token HTTP/1.1
  daemon: [daemon] connection-open / [daemon] connection-close   (no auth-failure)
  mock: POST /v1/chat/completions
  ```
  - The deltas arrive 251 / 252 / 251 / 251 ms apart, which is real
    streaming.
  - Only the `Origin` line differs between red and green: the token, daemon
    and socket are the same. So the 401 is the Origin gate, not the token.
  - No permission request arrived (text-only mock).
- *Screenshots* (untracked, in `.tentacle/tmp/mobile-spike/`):
  - `green.png`: the iPhone 17 Pro screen shows `url: ws://127.0.0.1:4001`,
    `status: ws close event: code=1000 reason=""`,
    `reply: Hello from the mock model.` and an empty `error:`. The dev-client
    gear button is at the top right.
  - `red.png`: the screen shows `url: ws://127.0.0.1:4000`, a status with
    `code=1006 reason="Received bad response code from server: 401."`, an
    empty reply, and `error: ChannelError: cannot reach the daemon (close 1006)`.
    The dev-client's first-launch menu sheet covers its lower half.
- *Teardown*: Metro, `strip-origin`, `serve` and the mock were killed.
  `lsof` on :4000/:4001/:4100/:8081 shows no listener. The app was
  terminated, and `xcrun simctl shutdown "iPhone 17 Pro"` was run.

### Findings for task 11 / the owner

- **RN does carry the HTTP status, in the close `reason`**
  (`"Received bad response code from server: 401."`). The error event's
  `message` is `undefined`, and the close code is always 1006. RN
  close-code classification can therefore parse `reason` instead of probing.
  Today every RN upgrade failure is `unreachable`, so a bad token would
  redial forever inside `RemoteClient`.
- **SocketRocket's `Origin` is `http://<dialed host:port>`**: the dialed URL
  with its scheme mapped to http. This bears on option (b) of the Origin
  policy. Behind a tunnel or proxy, the `Origin` is the address the phone
  dialed, not the daemon's bind address.
- The `types: ["bun"]` stopgap in `apps/mobile/tsconfig.json` remains (as
  planned).
- The final bundle id is still the placeholder `so.tentacle.spike`, and the
  Origin policy is not implemented (both deferred by the owner).
- Xcode reports 4 warnings, including the Dev Launcher's "ambiguous
  dependencies" build phase. They are cosmetic, but task 11 may silence them.

### Throwaway scripts (`.tentacle/tmp/mobile-spike/`, not committed)

`mock-model.ts`:
```ts
const DELTAS = ["Hello", " from", " the", " mock", " model."];
const enc = new TextEncoder();
const line = (e: unknown) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);
Bun.serve({
  port: 4100,
  hostname: "127.0.0.1",
  fetch(req) {
    console.log(`[mock] ${new Date().toISOString()} ${req.method} ${new URL(req.url).pathname}`);
    const body = new ReadableStream({
      async start(c) {
        for (const d of DELTAS) {
          c.enqueue(line({ choices: [{ delta: { content: d } }] }));
          await Bun.sleep(250);
        }
        c.enqueue(line({ choices: [{ delta: {}, finish_reason: "stop" }] }));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log("[mock] listening on http://127.0.0.1:4100/v1");
```

`strip-origin.ts` (byte-level; it ignores socket write backpressure, which is
fine for a spike's few small frames):
```ts
import type { Socket } from "bun";
type Up = { up?: Socket<Down>; head: Buffer; piped: boolean; pending: Buffer[] };
type Down = { client: Socket<Up> };
const SEP = Buffer.from("\r\n\r\n");
Bun.listen<Up>({
  hostname: "127.0.0.1",
  port: 4001,
  socket: {
    open(s) { s.data = { head: Buffer.alloc(0), piped: false, pending: [] }; },
    async data(s, chunk) {
      const st = s.data;
      if (st.piped) { if (st.up) st.up.write(chunk); else st.pending.push(Buffer.from(chunk)); return; }
      st.head = Buffer.concat([st.head, Buffer.from(chunk)]);
      const end = st.head.indexOf(SEP);
      if (end < 0) return;
      const lines = st.head.subarray(0, end).toString("latin1").split("\r\n");
      const rest = st.head.subarray(end + 4);
      const kept = lines.filter((l) => {
        if (/^origin:/i.test(l)) { console.log(`[strip-origin] ${new Date().toISOString()} stripped "${l}"`); return false; }
        return true;
      });
      if (kept.length === lines.length) console.log("[strip-origin] no Origin header present");
      console.log(`[strip-origin] request line: ${lines[0]}`);
      st.piped = true;
      st.pending.push(Buffer.concat([Buffer.from(`${kept.join("\r\n")}\r\n\r\n`, "latin1"), rest]));
      const up = await Bun.connect<Down>({
        hostname: "127.0.0.1",
        port: 4000,
        socket: {
          open(u) { u.data = { client: s }; },
          data(u, c) { u.data.client.write(c); },
          close(u) { u.data.client.end(); },
          error(u) { u.data.client.end(); },
        },
      });
      st.up = up;
      for (const p of st.pending) up.write(p);
      st.pending = [];
    },
    close(s) { s.data.up?.end(); },
    error(s) { s.data.up?.end(); },
  },
});
console.log("[strip-origin] listening on 127.0.0.1:4001 -> 127.0.0.1:4000");
```

`tui-connect.py` (drives `tentacle connect` in a 100×30 pty, types `hello`,
and greps the SGR-stripped screen). It is condensed here: the omitted lines
set `COLUMNS`/`LINES` in the child and echo the matching screen lines.
```python
import os, pty, sys, time, re, select, signal, fcntl, termios, struct
argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
buf = b""
def pump(secs):
    global buf
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: buf += os.read(fd, 65536)
            except OSError: return
pump(4); os.write(fd, b"hello"); pump(0.5); os.write(fd, b"\r"); pump(5)
text = re.sub(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-B]|\x1b[=>]", b"", buf).decode("utf8", "replace")
print("mock reply on screen:", "Hello from the mock model." in text)
os.write(fd, b"\x03"); pump(1); os.write(fd, b"\x03"); pump(2)
try: os.kill(pid, signal.SIGTERM)
except ProcessLookupError: pass
os.waitpid(pid, 0)
```
Logs: `.tentacle/tmp/mobile-spike/run/{baseline-check,check-1,check-final,run-ios-1,metro-red,metro-green,serve,mock,strip-origin}.log`.

**Lockfile note (orchestrator, after Review finding 2).** Beyond `react`, 7
bare lockfile keys flipped (`react`, `scheduler`, `ws`, `ansi-regex`, `cliui`,
`yargs`, `yargs-parser`); every `main` resolution is kept for its consumer
under a scoped key. No workspace package imports any of them undeclared:
`rg 'from "(ws|scheduler|ansi-regex|yargs|cliui|yargs-parser)"' packages scripts`
→ no match (2026-10-23). AGENTS §6 updated (packages + app, typecheck script).

## Review

*— claude-opus-5-5, 2026-10-23 (fresh context, separate account; **same model
family as the planner and executor**, so shared blind spots can survive both
passes)*

**Verdict: APPROVE-WITH-NITS.** The spike does what it claims. It changes no
`packages/*` source, and the gate is green with the expected deltas. The
load-bearing claim (React 18 for the TUI and React 19 for Metro in one isolated
workspace) holds on the real tree. The findings are about accuracy and missing
guards. None of them is a defect in shipped behaviour.

### Findings

1. **The `paths` pin is not guarded by the gate** (`apps/mobile/tsconfig.json:9-12`).
   I removed the `paths` block and ran `tsc -p apps/mobile --explainFiles`. It
   loads `@types+react@18.3.12/…/index.d.ts` and still **exits 0**. So the
   "Type split" failure mode (Implementation → Failure modes) is covered only
   by one-time evidence ("React 18 types loaded: 0"), not by `bun run check`.
   A regression would be silent. Task 11 should either assert it (e.g. fail if
   `--explainFiles` lists `types+react@18`) or record it as known debt.
2. **Lockfile and hoist claims are narrower than the facts.** Files §2 says
   "Existing pins unchanged; TUI's React moves to a scoped key". The
   residual-risk paragraph names only `react`. I parsed both lockfiles
   (`lockcmp.ts`): 129/139 of `main`'s keys are unchanged, and **7 bare keys
   flipped**:
   - `react` 18.3.1 → 19.3.0
   - `scheduler` 0.23.2 → 0.28.0
   - `ws` 8.22.0 → 7.5.13
   - `ansi-regex` 6.4.0 → 5.0.1
   - `cliui`, `yargs`, `yargs-parser`
   Every one of `main`'s resolutions is kept for its consumer, under a scoped
   key (`ink/ws`, `ink/scheduler`, `react-reconciler/scheduler`,
   `strip-ansi/ansi-regex`, `cli-highlight/yargs`, …) or equal to the new root.
   So the phantom-import surface of the hidden-hoist flip covers `ws` and
   `scheduler` too, not only `react`. The full suite and the React-18-only
   binary cover it in practice. Doc accuracy, not a defect.
3. **The task-11 recommendation "parse the close `reason` instead of probing"
   is unsafe as written** (Execution → Findings for task 11). A 401 has two
   causes here: the Origin gate and a bad token. The daemon audits both as
   `auth-failure /`, the same line (`daemon/src/ws-server.ts:207-209`).
   Parsing `"…401."` as `unauthorized` would show a terminal "bad token" for
   an Origin rejection. My Bun e2e also shows the reverse misreport: the
   Origin-rejected upgrade is classified `rejected (HTTP 426)`, because the
   probe GET carries no `Origin` and so passes. Task 9/11 should distinguish
   the two causes, either with a distinct status or audit line, or by fixing
   the Origin policy first.
4. **AGENTS.md §6 repo facts go stale with this branch.** It says "14
   packages" and "`bun run typecheck` — `tsc --noEmit`". There are now 15
   workspaces, and typecheck is two `tsc` passes. This should ride this
   branch (a fact update, not a rule change) or be listed as follow-up.
5. **Nit (spike-only):**
   - `apps/mobile/App.tsx:10` `const URL` shadows the WHATWG `URL` global in
     that module.
   - `App.tsx:31-35` formats errors inside the component (a small §7
     "components only render" slip).
   - `useEffect` has no cleanup, so a remount would run the spike twice.
   All are acceptable for a throwaway screen. Task 11 must not copy them.

### Gate (re-run by the reviewer)

`bun run check` → exit 0:
- Biome: `Checked 403 files … No fixes applied.`
- Tests: **1979 pass, 2 skip (the two opt-in skips), 0 fail, 7358 `expect()`
  calls, 1981 tests across 165 files.**
- Typecheck: `tsc --noEmit && tsc -p apps/mobile` both passed, with the
  generated `ios/` in the tree.

These match Execution evidence 3.

### Acceptance checks re-run

- **Metro export** (`bunx expo export --platform ios`): `index-fe41d651….hbc
  (1.8MB)`, the **same hash** as Execution 4 (a deterministic build). The
  `--no-bytecode --source-maps` sourcemap (an index map with `sections`) shows:
  - React copies: `react@19.3.0` only; `react-native@0.88.0`; `zod@3.23.8`.
  - Workspace sources: `apps/mobile` 5, `client` 11, `protocol` 12, `core` 11,
    `transport` 6 (= 45).
  - No `agent`, `daemon`, `tui`, `cli` or `tools` file is bundled, and no
    `node:` import. `for await` left in the bundle: 0.
- **React resolution** (readlink on the real tree):
  - `packages/tui` → `react@18.3.1`; `apps/mobile` → `react@19.3.0`.
  - `ink@5.0.1+b215e95ac4c38807` → 18.3.1;
    `react-native@0.88.0+20bbbbefde45c66a` → 19.3.0.
  - The hidden hoist → 19.3.0.
- **Release binary**: `bun run compile` → `version marker 0.1.0 ok`. `strings`
  finds only `"18.3.1"` React version literals (react + reconciler) and no
  `19.3.0`.
- **React types**: `tsc -p apps/mobile --explainFiles` lists 0
  `types+react@18` files with the pin (and some without it, see finding 1).
- **Not re-run:**
  - The scratch-copy filtered frozen install (`--filter '!@tentacle/mobile'`)
    followed by `compile`: the sandbox denied the copy (`rsync` and a bash
    script both needed approval I did not have). This rests on Execution 5.
  - The iOS simulator run (evidence 6–7): optional per the brief, not re-run.

### Mutation non-vacuity (§9)

| Mutation (`apps/mobile/src/rn-websocket.ts:19`) | Result |
|---|---|
| A: `new RN(url, init)` (init as protocols) | tests 1 and 2 **FAIL**, test 3 passes (it does not depend on argument order) |
| B: drop the `return` (the adapter yields its own empty instance, not the RN socket) | tests 2 and 3 **FAIL**, test 1 passes |
| C: `apps/mobile/tsconfig.json` without `paths` | `tsc` **passes** (finding 1: not pinned by the gate) |

Every test is killed by at least one mutation. After reverting, the
`shasum`s of all 13 touched files, `git status --short` and `git diff --stat`
are byte-identical to the pre-review snapshot.

### Premise table

| # | Premise (cited) | Verdict |
|---|---|---|
| 0 | Context symptom: an RN iOS client cannot connect to an unmodified `serve` (Origin gate) | **TRUE** (reproduced in a Bun e2e with an injected `Origin`: `[daemon] auth-failure /`, upgrade refused; without `Origin` the same token and daemon stream the reply). The simulator half was not re-run |
| 1 | `connect` drives `RemoteClient` with a WS factory, no model (`cli/src/connect.ts:88-118`, `:113`, `:134-135`) | TRUE |
| 2 | `modelProvider` optional (`client/src/remote-client.ts:252-261`); `MethodNotFound` without it (`:1269-1272`, `:1297-1302`) | TRUE |
| 3 | `PermissionBroker` defaults to `allowAll` with no requester (`core/src/permission.ts:107-110`) | TRUE (the spike passes an explicit deny requester, `spike.ts:76`) |
| 4 | Injectable `deps.WebSocket`; `new Ctor(target, init)`, `?token=` + `{headers}` (`client/src/ws-channel.ts:91-120`, `:172-198`); `WebSocketLike` = send/close/addEventListener (`:9-13`) | TRUE |
| 5 | RN ctor `(url, protocols, options)`, `extends EventTarget` (`react-native/Libraries/WebSocket/WebSocket.js:78`, `:100-104`) | TRUE |
| 6 | RN iOS dials via `SRWebSocket initWithURLRequest` (`RCTWebSocketModule.mm:152`); SocketRocket 0.7.1 (`scripts/cocoapods/helpers.rb:45-46`) | TRUE |
| 7 | `SRHTTPConnectMessage.m` always sets `Origin` | **UNVERIFIED statically**: no SocketRocket source in `apps/mobile/ios/Pods` (RN ships prebuilt deps). Supported empirically by Execution 7 (`strip-origin` logged `Origin: http://127.0.0.1:4001`) |
| 8 | Type-only `@tentacle/agent` import (`client/src/mapping.ts:10`) | TRUE |
| 9 | Runtime APIs: `randomUUID` (`remote-session.ts:121,139`), async gen (`queue.ts:51`), `AbortController` (`peer.ts:349`), `queueMicrotask` (`channel.ts:40`), `TextDecoder` only in `stream-channel.ts:33` | TRUE (± 1 line) |
| 10 | Origin gate rejects any `Origin` without an allow-list (`ws-server.ts:116-121`); 401 + audit (`:207-209`); loopback w/o token allowed (`:178`) | TRUE |
| 11 | `serve` never passes `allowedOrigins`; `ServeOptions` has no such field (`cli/src/serve.ts:44-55`, `:177-186`) | TRUE (`rg allowedOrigins packages/` → only `ws-server.ts` + its test) |
| 12 | Token sources (`cli/src/flags.ts:353-364`), audit lines (`cli/src/main.ts:362-381`) | TRUE (± 1 line) |
| 13 | Root `types: ["bun","react"]`, `@types/react 18.3.12` (`tsconfig.json:10`, `package.json:29`); root include packages-only (`:28-34`) | TRUE |
| 14 | `release.ts:84` globs only `packages/*`; the app is unversioned in `bun.lock` | TRUE (`bun.lock:17-19` has no `version` for `apps/mobile`) |
| 15 | `build.yml:52` is the only `bun install` in `.github/` | TRUE (one workflow; it only compiles and does not run the gate, so the filtered install never meets `tsc -p apps/mobile`) |
| 16 | `hooks/trust` with no `hooksTrust` option → `{trusted:false}` (not cited, checked as an attack) | TRUE (`remote-client.ts:553-555`): the spike's omission is fail-closed |

### Attacks tried

1. **The single-broker / auto-approve path (§7).**
   - Permissions: `spike.ts:76` builds exactly one broker with a deny
     requester and passes it to `RemoteClient`.
   - Hooks: `connect` passes a `hooksTrust` resolver that the spike omits. The
     absent resolver answers `{trusted:false}` (`remote-client.ts:553-555`).
   - **Nothing found**: no auto-approve path.
2. **End-to-end through the real code** (`.tentacle/tmp/mobile-spike-review/e2e.ts`).
   `runSpike` → `rnWebSocketCtor` → `webSocketChannelFactory` → `RemoteClient`
   → unmodified `serve --token` → mock SSE, with an RN-shaped constructor over
   Bun's `WebSocket` that throws if `protocols !== undefined`:
   - With `Origin`: refused, `auth-failure /`.
   - Without it: `reply="Hello from the mock model."`, 5 deltas ~50 ms apart,
     `turn_end`, clean close.
   - Bad token: `unauthorized` (Bun path).
   This **found finding 3** (the Origin 401 and the bad-token 401 are
   indistinguishable to the daemon audit; misclassified as 426 by the Bun
   probe).
3. **Lockfile drift beyond React.** Full key-by-key comparison: **found
   finding 2**. No resolution is lost.
4. **A gate that silently changes meaning.** Each check, then its result:
   - Biome counts exactly +9 files (the app sources).
   - `bun test` sees +1 file and +3 tests, with `ios/Pods` present.
   - `tsc -p apps/mobile` typechecks the test file too.
   - The root `tsc` stays packages-only.
   - The CI workflow runs no gate step that the filter could break.
   - **Nothing found**, apart from finding 1, a missing guard.
5. **Release path.** `bun.lock` keeps exactly 14 workspace `"version": "0.1.0"`
   entries, and the app entry has none, so `bumpBunLock(…, 14)` still holds.
   **Nothing found.**
6. **Prior art.** `rg` over `TODO.md`, `docs/library-bugs.md`, `docs/fix/`
   and `docs/eval/react-19-migration.md` found no open item on these paths.
   The React 19 eval concerns the TUI's own React and is not constrained here.
   **Nothing found.**

### What holds

- One session path: the app adds only a constructor shim and reuses
  `webSocketChannelFactory` + `RemoteClient`.
- The model stays daemon-side, and there is one deny broker.
- The TUI's React graph is unchanged: same peer-variant hashes, React-18-only
  binary.
- Metro bundles one React. The app sources are linted and typechecked.
- CI is filtered.
- No daemon security gate was weakened: the Origin bypass is a throwaway
  proxy outside the tree.

### How the executor behaved

- **Honest and disciplined.**
  - Every drift is recorded with its reason (class instead of arrow, the
    `protocols` type, `withDiagnostics`, split run mechanics).
  - Red → green → mutation is shown, including why test 3 survives mutation A.
  - The Execution's evidence matches my re-runs exactly: the same counts and
    the same `.hbc` hash.
  - It stopped for owner approval before `brew install cocoapods`.
- **Weak points:**
  - It over-generalised one data point into a task-11 recipe (finding 3).
  - It described the lockfile change more narrowly than it is (finding 2).
  - It treated a one-time evidence line as failure-mode coverage (finding 1).
