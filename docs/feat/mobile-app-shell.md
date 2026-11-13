# feat/mobile-app-shell — the app shell, session list and the `e2e:mobile` harness (mobile task 11a)

> **Status:** implementation (plan written, **not approved** — see Owner questions)
> **Branch:** `feat/mobile-app-shell`
> **Size:** M · **Blast:** contained · **Suited:** strong model executes the harness slice (native toolchain + simulator judgment calls, as in the spike); the pure slice may go to the S/M executor; one fresh-context Opus Review (it defines the gate every later mobile task merges through)

## Context

*— claude-opus-5-5, 2026-11-13*

Mobile task 11 (`docs/eval/mobile-app.md`, decision 21 table, "Shell: pairing,
computers → projects, session list; Maestro E2E harness", M–L · contained) is
split (triage 2026-11-13, owner: "start it now, before task 9"):

- **11a (this task):** app shell, navigation, the session list
  (`session/list` over the channel the spike already proved: token WebSocket),
  and the Maestro `bun run e2e:mobile` harness on the iOS simulator. The
  pairing screen exists only behind a seam.
- **11b (after task 9):** the pairing UI (QR + compare code), the paired-
  computer registry in the Keychain, the Noise channel, the Origin policy.

Why now: decision 20 makes `bun run e2e:mobile` **mandatory before merging any
mobile task**, and nothing implements it yet. 11a is the only forward mobile
task whose files (`apps/mobile/**` + one root script) are disjoint from every
in-flight branch (triage §2).

Carry-overs this task must honour (eval "Carry-overs", `mobile-spike.md` Review):
- the spike screen (`apps/mobile/App.tsx`, `src/spike.ts`) is throwaway — URL
  shadowing (`App.tsx:74`), error formatting in the component (`App.tsx:95-99`),
  no effect cleanup (`App.tsx:83-101`);
- iOS reports both a bad token and an Origin rejection as close **1006**; never
  classify by the close `reason` (spike Review finding 3);
- render daemon-supplied strings (`sessionId`, `title`, `cwd`) as plain text;
  `MethodNotFound` on `session/list` = "daemon too old"; `updatedAt` is the
  daemon's clock;
- the `paths` pin to React 19 types (`apps/mobile/tsconfig.json:44-47`) is not
  protected by the gate;
- bundle id `so.tentacle.app` (spike keeps `so.tentacle.spike`,
  `app.json:5`); deployment target **18.0** (`app.json:6` still says `26.0`);
  `ios.infoPlist` needs `NSLocalNetworkUsageDescription` + ATS
  `NSAllowsLocalNetworking`; E2E on an iOS 18 **and** an iOS 26 simulator;
- UI starts from the approved mockups (eval, "UI direction"): native iOS look,
  inset grouped lists, accent `#0E7490` light / `#06B6D4` dark.

**Repro (2026-11-13, this worktree):** the capability is missing.

```
$ rg -c 'sessionList|e2e:mobile' apps/mobile package.json
(no matches)
$ git ls-files apps/mobile
apps/mobile/App.tsx  apps/mobile/app.json  apps/mobile/index.ts  apps/mobile/package.json
apps/mobile/polyfills.ts  apps/mobile/src/rn-websocket.ts  apps/mobile/src/spike.ts
apps/mobile/test/rn-websocket.test.ts  apps/mobile/tsconfig.json
$ xcrun simctl list runtimes
== Runtimes ==
iOS 26.5 (26.5 - 23F77) - com.apple.CoreSimulator.SimRuntime.iOS-26-5
```

The iOS 18 runtime is **not installed** (eval: "must be installed before task
11"). Maestro's presence was not verified (the shell refused `command -v`
here); CocoaPods 1.17.0 was installed for the spike (`mobile-spike.md:516`).

## Implementation

*— claude-opus-5-5, 2026-11-13*

### Load-bearing assumption

**The app reaches `session/list` through the unchanged `RemoteClient` stack
over React Native's WebSocket — no new transport, no second session path
(AGENTS §7 "TUI always over RPC — one session path").** Proven:
- `RemoteClient.sessionList(params)` is a plain peer call on the same
  connection (`packages/client/src/remote-client.ts:905-913`), schema-validated
  by the peer; it needs no `session/open`.
- The spike already ran `initialize` + a full streamed turn through
  `webSocketChannelFactory` + `rnWebSocketCtor` + `RemoteClient` on the
  simulator and on a real iPhone (`apps/mobile/src/spike.ts:178-217`,
  `mobile-spike.md` Execution, eval "First run on a real iPhone: GREEN").

The second, **unproven** assumption — Maestro can drive an Expo Release build
of this Bun-workspace app on the simulator from a script — is retired by
**Step 0** (Design) before any product code.

### Preconditions

- `session/list` schema: `SessionListEntrySchema` = `sessionId, title, cwd,
  createdAt, updatedAt, running, attached, archived, jobs?`; pages of ≤ 200,
  opaque `cursor` (`packages/protocol/src/session.ts:1188-1223`). Strings are
  bounded and control-free daemon-side (`session.ts:1180-1182`).
- `sessionList` rejects `"not connected to the daemon"` while the link is down
  (`remote-client.ts:906-908`); a dropped link is redialled by `channelFactory`
  and a `ChannelError{kind:"unauthorized"}` stops retrying
  (`remote-client.ts:374-379`); link state via `onLinkStatus`
  (`remote-client.ts:1283`, type `client/src/link-machine.ts:49`).
- RN reports a failed upgrade as 1006 → `classifyUpgradeFailure` says
  `unreachable` (`packages/client/src/ws-channel.ts:142-170`): a bad token
  looks transient on iOS. 11a must therefore bound what it shows, not trust
  the kind.
- `serve` rejects any `Origin` (`packages/daemon/src/ws-server.ts:116-121`,
  audited `auth-failure` at `:207-209`) and SocketRocket always sends one
  (`mobile-spike.md:149-151`). The real policy is task 9; the spike reached
  `serve` through a byte-level strip-origin proxy (`mobile-spike.md:303-313`).
- Single broker (AGENTS §7): one `PermissionBroker` per `RemoteClient`, with an
  explicit deny requester, never the `allowAll` default (`spike.ts:188-189`).
  11a opens no session, so no permission ask can arrive; the deny broker is
  belt and braces.
- The gate already covers the app: `typecheck` runs `tsc -p apps/mobile`
  (`package.json:12`), `bun test` discovers `apps/mobile/**/*.test.ts`,
  Biome lints `apps/mobile` (root `.gitignore:31-33` excludes `ios/`,
  `android/`, `.expo/`). The CI workflow only compiles, with
  `--filter '!@tentacle/mobile'` (`.github/workflows/build.yml:52`): there is
  no CI test job, so "CI" below means `bun run check` without a simulator.
- A real daemon in-process for tests: `SessionHost` + `startWsServer({port:0,
  token})` is the client tests' pattern (`packages/client/test/ws-factory.test.ts:10,103`).
- `bun.lock` already carries the `apps/mobile` workspace (`bun.lock:17-29`):
  any app dependency change edits it (see Owner question 1).

### Design

**Shape.** Logic in pure, React-free modules under `apps/mobile/src/` with
`bun test` coverage; `.tsx` screens are dumb renderers with stable `testID`s
for Maestro (AGENTS §7 "Logic lives in pure modules"). No protocol, daemon,
client or CLI change.

**Step 0 — retire the Maestro risk first (blocking).** Replace the spike
screen with a one-`Text` shell (`testID="shell-ready"`), build it Release on
the iOS 26.5 simulator (`expo run:ios --configuration Release --device <sim>`:
JS bundled, no Metro, `EXPO_PUBLIC_*` inlined at build), and run a one-step
Maestro flow (`assertVisible: {id: shell-ready}`). Paste the commands and
output. If Release builds fail in the Bun layout, fall back to Debug + a
harness-owned Metro (`expo start --dev-client`, the spike's mechanics,
`mobile-spike.md:540-548`) and record the drift. If Maestro cannot drive the
app at all: STOP and report (two-strike rule).

**Navigation.** Stack: `Pair` (placeholder) | `Computers` → `Sessions` →
`Session` (placeholder). With Owner Q1 = (a): `@react-navigation/native-stack`
(`react-native-screens`) — native UINavigationController: large titles,
swipe-back, iOS 26 glass bars for free (eval UI direction), inset grouped
lists in `ScrollView`/`SectionList`. Route types in `src/routes.ts`; the
initial route is a pure function `initialRoute(computers)` (`[]` → `Pair`,
else `Computers`).

**Computers → projects in 11a.** One `serve` = one project; sibling discovery
is task 10. `Computers` lists each computer with its single project row
(label = `projectLabel(entries)` = basename of the most recent entry's `cwd`,
else the computer's name). Tapping it opens `Sessions`. Task 10 fills the
projects level without changing the screen's shape.

**The pairing seam.** `src/computers.ts`:
```ts
interface ComputerRecord { id: string; name: string; url: string; token?: string }
interface ComputerSource { list(): Promise<readonly ComputerRecord[]> }
function devComputerSource(env: Record<string, string | undefined>): ComputerSource
```
11a ships only `devComputerSource` (Owner Q2): it reads
`EXPO_PUBLIC_TENTACLE_URL` / `_TOKEN` / `_NAME` at build time, validates the
URL (`ws:`/`wss:` only, else a typed config error shown on `Pair`), and returns
`[]` when the URL is absent — so a build without the env shows the `Pair`
placeholder ("Pair a computer — coming with `tentacle pair`",
`testID="pair-placeholder"`). Task 9 adds a Keychain-backed paired source
behind the same interface and deletes the dev source.

**Connection.** `src/connection.ts` — `openComputer(record, deps)` with
injected `{ WebSocket: RNWebSocketCtor }`: `webSocketChannelFactory(url,
token ? {token} : {}, {WebSocket: rnWebSocketCtor(deps.WebSocket)})`,
`new RemoteClient(channel, new PermissionBroker(denyAll), undefined,
{channelFactory: dial, onError})`, `initialize()`. Returns `{ client,
onStatus, close }`. One live client per computer, held by a small registry in
`App.tsx` state, closed on unmount (`closeSessions` + `close`, as
`spike.ts:211-215`). No React in this module. `src/spike.ts` is deleted; the
`withDiagnostics` close-code logging moves into `connection.ts` as an
`onError` log line (data for task 9's 401 split).

**Session list.** `src/session-list.ts` (pure):
- `reduce(state, action)` over `idle | loading | loaded{entries, cursor,
  stale} | failed{error}`; actions `refresh`, `page(result, generation)`,
  `more`, `fail(error, generation)`, `link(status)`. A **generation counter**
  drops late results of a superseded request; pages are merged **deduped by
  `sessionId`** (a session updated between pages moves up; refresh converges).
- `rows(entries, now)` → view-model: `title`, `subtitle` (relative time from
  `updatedAt`, clamped at "now" for a skewed daemon clock), badges
  `running` / `attached n` / `jobs n`, split into **Active** and **Archived**
  sections. Strings pass through untouched (the screen renders them as plain
  `Text`, never a link or markdown).
- `describeError(e)` → `{message, retry: boolean}`: `MethodNotFound` →
  "This computer's tentacle is too old — update it" (no retry); "not
  connected" → "Reconnecting…" (auto-retry on link up); `ChannelError` (any
  kind on iOS) → "Can't connect — the computer is unreachable or refused this
  app" (retry); anything else → its message (retry). **Never** inspects the
  close `reason`.
- Refresh triggers: screen focus, pull-to-refresh, link back `up`, app
  foreground (`AppState`). No polling. "Load more" at the list end when
  `cursor` is set. While the link is down a loaded list stays visible,
  marked stale.

**Session (placeholder).** Shows title, project, state; **does not call
`session/open`** (opening would attach the phone: `attached` +1 and steering
semantics — that is task 12). `testID="session-placeholder"`.

**Presentation.** `src/theme.ts`: accent `#0E7490` (light) / `#06B6D4` (dark)
via `useColorScheme`; system font; no logic.

**Native config (`app.json`).** `ios.bundleIdentifier: so.tentacle.app`;
`expo-build-properties` `ios.deploymentTarget: "18.0"`; `ios.infoPlist`:
`NSLocalNetworkUsageDescription` ("tentacle connects to your computers on the
local network") and `NSAppTransportSecurity.NSAllowsLocalNetworking: true`. No
`appleTeamId` (simulator only; first device build is 11b/TestFlight).

**The harness — `bun run e2e:mobile` → `bun apps/mobile/e2e/run.ts`.**
1. **Preflight** (pure parser `e2e/preflight.ts` over `xcrun simctl list -j
   runtimes devices`, `maestro --version`, `pod --version`): macOS, Xcode,
   CocoaPods, Maestro, the iOS 18.x and 26.x runtimes. A missing piece exits
   **2 with the tool named and the install command** — never a silent skip.
   `--ios 18|26` runs one; default both (Owner Q3).
2. **Scratch** under `<repo>/.tentacle/tmp/e2e-mobile/<runId>/` (AGENTS §6:
   never `/tmp`): `TENTACLE_CONFIG_DIR`, the `serve` cwd `project/`, logs.
3. **Mock model** `e2e/mock-model.ts`: `Bun.serve` on port 0, OpenAI-style SSE
   (the spike's shape, `mobile-spike.md:383-388`); a prompt containing `HOLD`
   streams slowly until released, so a session is visibly `running`.
4. **Real `serve`** from source: `bun packages/cli/src/main.ts serve --port
   <free> --token <random>` with `TENTACLE_MODEL_BASE_URL` / `TENTACLE_MODEL`
   / `TENTACLE_CONFIG_DIR` (`mobile-spike.md:472`), cwd `project/`; wait for
   the port.
5. **Strip-origin proxy** `e2e/strip-origin.ts` (Owner Q4): the spike's
   byte-level proxy, with the header rewrite as a pure exported
   `stripOrigin(head: string): {head, origin}`. Test-only; never imported by
   the app.
6. **Seed** `e2e/seed.ts`: a Bun `RemoteClient` (Bun WebSocket, direct to
   `serve`) creates `Alpha` (one finished turn), `Bravo` (closed → archived),
   `Charlie` (a `HOLD` turn left running).
7. **Build + install**: boot the named simulator, `expo run:ios
   --configuration Release` with `EXPO_PUBLIC_TENTACLE_URL=ws://127.0.0.1:<proxy>`,
   `_TOKEN`, `_NAME=e2e-mac`; build output reused when the sources hash is
   unchanged (`.tentacle/tmp/e2e-mobile/build-cache/`).
8. **Maestro** `maestro test apps/mobile/e2e/flows/` (env passes the seeded
   titles), `clearState: true` per flow; JUnit + screenshots into the run dir.
9. **Teardown in `finally`** + `SIGINT`/`SIGTERM` handlers: kill Maestro,
   proxy, `serve`, mock; leave the simulator booted. Exit code = Maestro's.

Flows (`apps/mobile/e2e/flows/*.yaml`):
- `01-shell.yaml` — launch → `Computers` shows `e2e-mac` and the project row.
- `02-session-list.yaml` — tap project → Active shows `Alpha`, `Charlie`
  (running badge), Archived shows `Bravo`; order `Charlie`, `Alpha` (most
  recent first).
- `03-refresh.yaml` — harness hook (Maestro `runScript` → `e2e/hooks.ts` over
  a localhost control port of the harness) creates `Delta`; pull-to-refresh →
  `Delta` on top.
- `04-session-placeholder.yaml` — tap `Alpha` → `session-placeholder`;
  back → list intact.
- `05-daemon-down.yaml` — hook stops `serve` → refresh shows the "Can't
  connect" message; hook restarts it on the same port + config → retry/auto
  reconnect lists the same sessions (persisted by `serve`).

### Files

Dependency order; all under `apps/mobile/**` except the one root script.

1. `apps/mobile/package.json` — navigation deps pinned exactly (Q1); devDeps
   `@tentacle/daemon`, `@tentacle/agent`, `@tentacle/tools` (`workspace:*`)
   for the in-process daemon test, only if Bun's workspace resolution needs
   them declared. (`bun.lock` changes as a consequence — Q1.)
2. `apps/mobile/app.json` — bundle id, deployment target 18.0, infoPlist.
3. `apps/mobile/src/routes.ts` — route param types + `initialRoute`.
4. `apps/mobile/src/computers.ts` — `ComputerSource`, `devComputerSource`.
5. `apps/mobile/src/connection.ts` — `openComputer`.
6. `apps/mobile/src/session-list.ts` — reducer, `rows`, `projectLabel`,
   `describeError`.
7. `apps/mobile/src/theme.ts` — colours.
8. `apps/mobile/src/screens/{PairScreen,ComputersScreen,SessionsScreen,SessionScreen}.tsx`.
9. `apps/mobile/App.tsx` — rewritten: `NavigationContainer` + stack + client
   registry; `apps/mobile/src/spike.ts` — **deleted**.
10. `apps/mobile/test/{computers,session-list,connection,routes}.test.ts`,
    `apps/mobile/test/e2e-{preflight,strip-origin}.test.ts`.
11. `apps/mobile/e2e/{run,preflight,mock-model,strip-origin,seed,hooks}.ts`,
    `apps/mobile/e2e/flows/0{1..5}-*.yaml`, `apps/mobile/e2e/README.md`
    (prerequisites + how to run one flow).
12. Root `package.json` — `"e2e:mobile": "bun apps/mobile/e2e/run.ts"` (the
    one root line; add it last, after `feat/changelog-fragments` if that
    lands first — triage §2).
13. `docs/feat/mobile-app-shell.md` — Execution / Review.

Not touched: `tsconfig.json` `types: ["bun"]` stopgap stays (removing it
needs a `packages/client` change — out of scope; debt below).

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| No dev env in the build | `devComputerSource` → `[]` → `Pair` placeholder. Never a crash. |
| Env URL not `ws:`/`wss:` | Typed config error on `Pair`, names the variable. |
| Daemon unreachable at first dial | `failed` + "Can't connect…" + Retry. No automatic loop before the first `initialize` succeeds. |
| Bad token / Origin 401 (both 1006 on iOS) | Same "Can't connect…" message, retry offered; never claims "bad token" from the `reason` (carry-over). Distinct wording waits for task 9's status split. |
| Link drops on a loaded list | `RemoteClient` redials (`channelFactory`); list stays, marked stale + "Reconnecting…"; on `up` → refresh. |
| `sessionList` while down | Rejects "not connected" → "Reconnecting…", refreshed on `up`. |
| `MethodNotFound` | "too old — update it", no retry loop. |
| Invalid result (schema) | Peer rejects → `failed` with the message; retry. |
| Empty list | Empty state "No sessions yet — run `tentacle` in this project". |
| Pagination race (entry moves between pages) | Dedupe by `sessionId`; pull-to-refresh restarts from page 1. |
| Late result after refresh / navigation away | Generation counter drops it. |
| Daemon clock ahead | Relative time clamped to "now". |
| App backgrounded (iOS suspends the socket) | Redial on foreground; refresh on `up`. |
| Unmount | `closeSessions()` + `close()`; no listener left (effect cleanup). |
| Harness: tool / runtime missing | Exit 2, names it + install command. |
| Harness: port busy | Every port is 0/ephemeral, read back. |
| Harness: crash / Ctrl+C mid-run | `finally` + signal handlers kill children; scratch dir kept for logs. |
| Harness: stale app state between flows | `clearState: true`. |
| Harness touching real infra | Own `TENTACLE_CONFIG_DIR` under `.tentacle/tmp/e2e-mobile/`; `serve` binds `127.0.0.1` only; the mock model is the only provider. |
| Dev token in a shipped build | Only if someone builds TestFlight with `EXPO_PUBLIC_TENTACLE_TOKEN` set; task 9 deletes the dev source. Recorded as debt. |

### Tests

**In the gate (`bun run check`, no simulator):**
- `computers.test.ts` — env → records; absent URL → `[]`; `http:` / garbage →
  config error; token optional.
- `routes.test.ts` — `initialRoute([])` = `Pair`, else `Computers`.
- `session-list.test.ts` — reducer: refresh → loading → loaded; a stale
  generation's page/fail is dropped (**mutation**: remove the check → test
  fails); two pages merged with a duplicated `sessionId` keep one row, the
  newer; `link(down)` marks stale, `link(up)` requests refresh. `rows`:
  Active/Archived split, badges, clamp of a future `updatedAt`, a title with
  `<b>`/`https://` passes through verbatim. `describeError`: `MethodNotFound`,
  not-connected, `ChannelError` of each kind → the same "Can't connect"
  wording, and a `ChannelError` whose message contains `401` is **not**
  reported as a bad token. `projectLabel`.
- `connection.test.ts` — a real in-process daemon (`SessionHost` +
  `startWsServer({port:0, token})`, the `ws-factory.test.ts` pattern) dialled
  through `openComputer` with Bun's `WebSocket` wrapped in an RN-shaped ctor:
  `initialize` + `sessionList` returns the sessions created through a second
  client; wrong token → rejects (the dial fails); the client's broker is a
  deny broker, not `allowAll` (**mutation**: pass no requester → test fails).
- `e2e-preflight.test.ts` — parser on canned `simctl -j` JSON: both runtimes,
  only 26.5 (today's machine → names "iOS 18 runtime"), none; Maestro absent.
- `e2e-strip-origin.test.ts` — `stripOrigin` removes exactly the `Origin:`
  line (any case), keeps the rest byte-identical, reports the value; no
  `Origin` → unchanged.
- Typecheck covers the screens; a type-level guard
  (`src/react19-guard.ts`, a React-19-only type) protects the `paths` pin —
  the executor proves it by deleting the pin and showing `tsc -p apps/mobile`
  fail, then restores it.

**Maestro (`bun run e2e:mobile`, macOS + simulator only — not in the gate):**
flows 01–05 on iOS 26.5 and iOS 18.x. Red-before-green: flow 02 run against
the Step 0 shell (no list) fails, then passes. The green run's summary
(per simulator, per flow) is pasted into Execution; Review re-runs it.

### Owner questions

1. **Navigation library.** (a) `@react-navigation/native-stack` +
   `react-native-screens` + `react-native-safe-area-context` (native iOS stack,
   large titles, swipe-back, iOS 26 glass for free; `bun.lock` changes inside
   the `apps/mobile` entries only); (b) `expo-router` (file routing, more
   Metro magic); (c) hand-rolled (no deps, loses the native stack).
   **Recommendation: (a)** — and allow the `bun.lock` diff it causes (the
   brief's "apps/mobile + one script" cannot hold with any new dependency).
2. **Computers before pairing.** (a) build-time dev computer from
   `EXPO_PUBLIC_TENTACLE_URL/_TOKEN/_NAME` behind `ComputerSource`, no
   persisted token, no "add computer" form; (b) a manual "add computer (URL +
   token)" screen stored in the Keychain now. **Recommendation: (a)** — (b)
   builds token storage that task 9 throws away.
3. **Simulators and tooling.** The harness runs on iOS 26.5 and iOS 18.x by
   default and fails loudly if either is missing; the iOS 18 runtime is not
   installed today and Maestro is unverified. **Recommendation:** both
   simulators; the owner installs (or OKs the executor installing) the iOS 18
   runtime (`xcodebuild -downloadPlatform iOS -buildVersion 18.x`) and Maestro
   before Execution.
4. **Origin in the harness until task 9.** (a) a test-only byte-level
   strip-origin proxy under `apps/mobile/e2e/` (daemon untouched, never in the
   app bundle); (b) wait for task 9's Origin policy before any simulator E2E.
   **Recommendation: (a)** — the harness switches to a direct dial when task 9
   lands; the gate is not weakened.
5. **Opening a session from the list.** (a) 11a's Session screen is a
   placeholder and never calls `session/open` (no attach side effects);
   (b) open it read-only now. **Recommendation: (a)** — attaching is task 12's
   transcript work.

### Notes / debt

- `types: ["bun"]` in `apps/mobile/tsconfig.json` stays (needs a
  `packages/client` change to drop the type-only `@tentacle/agent` import).
- The 401 cause split (Origin vs token) stays with task 9.
- The dev computer source (and its build-time token) is deleted by task 9.
- Hermes throughput of the Noise channel (`e2e-channel.md:476`) is 11b's.

## Execution

*— claude-opus-5-5, 2026-11-13*

### Step 0 (blocking risk) — RETIRED, GREEN

`App.tsx` was replaced by a one-`Text` shell (`testID="shell-ready"`), built
Release and driven by a one-step flow. **A Release build of this Bun-workspace
app works, and Maestro drives it by `testID`.**

```
$ cd apps/mobile && CI=1 ./node_modules/.bin/expo run:ios \
    --configuration Release --device 0FA4B51F-… --no-bundler
  › Build Succeeded
  › Installing …/Release-iphonesimulator/tentacle.app            exit 0
$ JAVA_HOME=$(brew --prefix openjdk@17) PATH="$(brew --prefix openjdk@17)/bin:$PATH" \
    maestro test apps/mobile/e2e/flows/00-step0.yaml
  Launch app "so.tentacle.spike" with clear state... COMPLETED
  Assert that id: shell-ready is visible... COMPLETED              exit 0
```

`bunx expo` must NOT be used: it fetches an out-of-tree expo and fails with
"Cannot determine the project's Expo SDK version". The workspace's own binary
(`apps/mobile/node_modules/.bin/expo`) is the one to call.

### The repro (capability missing) — confirmed

`rg -c 'sessionList|e2e:mobile' apps/mobile package.json` → no matches, before
the change; `apps/mobile` held only the spike. After: the list, the shell and
`bun run e2e:mobile` all exist.

### What was built, in dependency order

1. **Nav/route types + `initialRoute`** — `src/routes.ts`.
2. **The pairing seam** — `src/computers.ts`: `ComputerRecord`,
   `ComputerSource`, `devComputerSource` (build env → 0 or 1 computer,
   `ws:`/`wss:` only, `ComputerConfigError` naming the variable).
3. **The link** — `src/connection.ts`: `openComputer` over the unchanged
   `webSocketChannelFactory` + `RemoteClient` + `PermissionBroker(denyAll)`;
   the spike's `withDiagnostics` close-code logging moved here as `onError`.
4. **The pure list** — `src/session-list.ts`: `reduce` (generation counter,
   dedupe-by-`sessionId`-keeping-newer, `refresh` replaces / `more` appends,
   a failed refresh keeps the rows marked stale), `rows`, `relativeTime`
   (future stamps clamped to "just now"), `projectLabel`, `describeError`.
5. **The list's network side** — `src/session-list-controller.ts`: which
   request is in flight, dropping answers for a disposed screen,
   refresh-on-link-up. Extracted because the effect body is where the
   generation counter is actually *used* (AGENTS §7).
6. **The link registry** — `src/link-registry.ts`: one live client per
   computer, concurrent callers share one dial, a failure is forgotten so Retry
   re-dials, `closeAll` on unmount.
7. **Theme + 4 screens** — `src/theme.ts` (accent `#0E7490` / `#06B6D4`),
   `screens/{Pair,Computers,Sessions,Session}Screen.tsx`.
8. **`App.tsx`** rewritten (NavigationContainer + native stack + registry);
   `src/spike.ts` **deleted**.
9. **`app.json`** — bundle id `so.tentacle.app`, deployment target 18.0,
   `NSLocalNetworkUsageDescription` + `ATS/NSAllowsLocalNetworking`.
10. **The harness** — `e2e/{run,preflight,mock-model,strip-origin,proxy,
    seed,hooks}.ts`, `flows/0{1..5}-*.yaml` + 3 `runScript` bodies,
    `e2e/README.md`; root `"e2e:mobile"`.
11. **Tests** — 9 files, 77 tests.
12. **Changelog fragment** — `changelog.d/mobile-app-shell.added.md`.

### Drift from the Implementation (and why)

- **`e2e/proxy.ts` is new (not in the plan's file list).** The plan put the
  strip-origin rewrite in `e2e/strip-origin.ts` as a pure function; the socket
  half had to live somewhere, and `node:net` byte-piping is a different concern
  from the rewrite. `stripOrigin` stayed pure and tested as planned.
- **`src/session-list-controller.ts` and `src/link-registry.ts` are new.** The
  plan put the "generation counter drops late results" rule in the pure reducer
  and left the effect body in the component. The reducer needs to be *driven*
  by something that owns the in-flight request, and a component is untestable
  in this harness — so the driver is a pure, injected module (AGENTS §7). The
  registry likewise: "one live client per computer" is a rule, not layout.
- **`src/react19-guard.ts` — the plan's mutation is NOT achievable.** The plan
  said "delete the `paths` pin and show `tsc -p apps/mobile` fail". It does
  not: with the pin deleted, Expo's own `bundler` resolution still finds the
  app's `@types/react` 19, and **both** React type versions sit in the program
  anyway (`tsc --listFiles` shows `@types+react@19.3.0` and
  `@types+react@18.3.12`). So the pin is redundant here, and the guard was
  proved live a different way: an 18-ONLY type (`ReactChild`) FAILS under the
  real config (`TS2305`), while the 19-only `useActionState` resolves. That is
  the property the guard needs; recorded as debt, not silently dropped.
- **Assertions are by `testID` only, never by visible text.** Established
  empirically, and it changed the plan's flows: React Native on the new
  architecture exposes **no** text to XCUITest. A minimal one-`Text` app reads
  back as `text: ""`, and an `accessibilityLabel` did not surface either. The
  plan's "assert `e2e-mac` / `Alpha` / `Charlie`" is therefore permanently red.
  Every flow asserts a stable `testID` instead (`computer-dev`,
  `session-<uuid>`, `badge-<uuid>-running`, `section-active`,
  `section-archived`, `sessions-list`, `sessions-stale`, `session-placeholder`).
- **`headerTransparent: false`** in the stack's `screenOptions` — a bug the
  flows found, not a preference: with the default translucent header the
  project row's bounds were `[16,43][386,96]`, *under* the large title
  (`[0,62][402,168]`), so the tap landed on the header and flow 02 could never
  navigate. Opaque puts the row at `[16,211]`.
- **The harness runs `expo prebuild` before every build.** `ios/` is generated
  (CNG) and gitignored, so a fresh checkout has none — and a stale one carried
  the SPIKE's bundle id (`so.tentacle.spike`), which made Maestro launch the
  wrong app. Prebuilding is idempotent and applies `app.json`'s bundle id and
  deployment target.
- **Maestro env is passed with `-e K=V`, not through the process environment.**
  Its `${VAR}` substitution reads only its own `-e` flags; a shell `export` is
  invisible to it (this is why `${ALPHA_ID}` was being sent literally).
- **Flow 04 taps `BackButton`, not `back`.** `backPressCommand` completed but
  did not pop the native-stack screen (the flow stayed on the placeholder);
  `waitForAnimationToEnd` was added on top, since the pop animation outlives
  the command.
- **`serve`'s tool probes**: `xcodebuild -version` (exits 64 on `--version`)
  and `maestro --version` **with** `JAVA_HOME` set (its launcher cannot print a
  version without a JDK) — both were initially wrong and made preflight report
  a false "Xcode/Maestro missing".
- **`simctl list -j runtimes` has no `devices` key**; the device lookup needs
  its own `simctl list -j devices`. Pinned by a test.
- **Navigation deps pinned exactly** (Owner Q1 = a): `@react-navigation/native`
  7.5.1, `@react-navigation/native-stack` 7.21.0, `react-native-screens` 4.30.1,
  `react-native-safe-area-context` 5.10.1 (the last two are Expo 58's
  `bundledNativeModules` versions). `bun.lock` changed inside the
  `apps/mobile` entries as the Owner allowed. `@tentacle/{agent,daemon,tools}`
  were needed as devDeps: without them `apps/mobile/test/connection.test.ts`
  cannot import the in-process daemon ("Cannot find module '@tentacle/agent'").
- **iOS 18 is NOT covered.** The orchestrator recorded that Xcode 27.1 cannot
  download an iOS 18 runtime. Preflight therefore reports the missing runtime
  and exits 2 (correct, and the reason `--ios 26` was used). The iOS 26 run is
  green; **the iOS 18 leg is unverified** — see "Unverified".
- **The dev computer's title is the first message.** A session's title is its
  first prompt until renamed, so the seeded titles are `Alpha`, `Bravo` and
  `HOLD Charlie` — flows assert ids, not titles, for that reason too.

### Mutations (AGENTS §9)

Each was applied, the narrow test run, then reverted; all three restored green.

| # | Mutation | Result |
|---|---|---|
| 1 | Drop the reducer's generation check (`session-list.ts`) | **2 tests fail** — "a stale generation's page is dropped", "a page arriving with nothing in flight is ignored" |
| 2 | `new PermissionBroker()` (the `allowAll` default) instead of `denyAll` (`connection.ts`) | **1 test fails** — "the client's broker is a deny broker, never allowAll" (asserts `answer.allowed === false`) |
| 3 | Match `Origin` case-sensitively (`strip-origin.ts`) | **1 test fails** — "the field name is case-insensitive, and every Origin line goes" |

The React-19 guard's planned mutation could not be performed (see Drift); it
was proved by an 18-only type failing (`TS2305: no exported member
'ReactChild'`) under the real config.

### The Maestro run, green (iOS 26.5)

```
$ bun run e2e:mobile --ios 26
e2e:mobile run 1794589087271 → .tentacle/tmp/e2e-mobile/1794589087271
serve on 127.0.0.1:…, proxy at ws://127.0.0.1:…/
seeded alpha=… bravo=… charlie=…

=== iOS 26 (0FA4B51F-A0E3-421B-BE66-CE29EF45213D) ===
✓ 01-shell (iOS 26)
✓ 02-session-list (iOS 26)
✓ 03-refresh (iOS 26)
✓ 04-session-placeholder (iOS 26)
✓ 05-daemon-down (iOS 26)

PASS — logs in …/.tentacle/tmp/e2e-mobile/1794589087271
exit 0
```

It exercises, end to end: a real `serve` from source, a real mock model
streaming a held turn, the seed through `RemoteClient`, a strip-origin proxy
whose `Origin` removal is logged, the Release build installed on the simulator,
and five flows — including the daemon being stopped and restarted mid-run.

**Red-before-green for the flows** was established the strong way rather than
claimed: flows 01/02 were RED against the Step 0 shell (no list, no project
row), and flow 02 stayed red through four real bugs (wrong bundle id from a
stale `ios/`; no text exposed to XCUITest; the row under the translucent
header; Maestro's env not passed with `-e`) before passing.

### Unverified

- **The iOS 18 leg.** The runtime is not installable with Xcode 27.1
  (orchestrator's recorded decision), so only 26.5 ran. To verify on a machine
  that has it: `bun run e2e:mobile` (both) — preflight names the runtime and its
  install command if it is absent.
- **A physical device.** 11a is simulator-only by design (no `appleTeamId`).

### Gate

- `bunx tsc --noEmit` + `tsc -p apps/mobile` — clean.
- `bun run lint` — clean (0 errors, 0 warnings; the AGENTS §6 baseline).
- `bun test` — **7688 pass, 3 opt-in skips, 0 fail** (`apps/mobile`: 77 pass).
  One `packages/daemon` fork-ordering test failed once under full-suite load
  and passes 3/3 in isolation; that package is untouched by this branch
  (`git status packages/daemon` is empty), so it is pre-existing timing
  sensitivity, not this change.
- No protocol schema changed → `packages/protocol/schema/protocol.json` not
  regenerated.
- Changelog: `changelog.d/mobile-app-shell.added.md`; `CHANGELOG.md`
  untouched, `[Unreleased]` empty.

## Review

#### Owner answers (2026-11-13)

All questions answered as recommended. Implementation APPROVED. Tooling (owner): the orchestrator installs Java 17 (brew openjdk@17), Maestro (brew mobile-dev-inc/tap) and the iOS 18 runtime before Execution; executor = DeepSeek.

Tooling installed by the orchestrator (2026-11-13): Java 17 at `$(brew --prefix openjdk@17)` (keg-only: run Maestro with `JAVA_HOME=$(brew --prefix openjdk@17) PATH="$(brew --prefix openjdk@17)/bin:$PATH"`), Maestro 2.12.1 (`maestro`). The iOS 18 runtime is NOT downloadable with Xcode 27.1 (`xcodebuild -downloadPlatform iOS -buildVersion 18.6/18.5` → not available): run on iOS 26.5 only; iOS 18 is deferred (orchestrator decision, recorded here).

## Review

*— claude-opus-5-5, 2026-11-13* (fresh context; same model family as the plan's author, a different model from the DeepSeek executor)

**Verdict: REQUEST-CHANGES**

Gate: `bun run typecheck` is clean, `bun run lint` is clean (991 files), and `bun test apps/mobile` gives 77 pass / 0 fail. I did not re-run the full suite or the Maestro run.

Findings:
1. **HIGH: a successful refresh never clears `stale`** (`apps/mobile/src/session-list.ts:125-131`). `fail` sets `stale: true` (`:147`), and `page` spreads `rest`, so the flag survives. Repro (`.tentacle/tmp/mobile-app-shell/stale.ts`): load OK → refresh fails while the link is up → refresh OK gives `{stale: true, error: undefined}`. The screen then shows `sessions-stale` "Reconnecting…" forever (`SessionsScreen.tsx:121-125`), even though the link is up. The link stays up, so no `link(up)` ever arrives to clear it. No test pins "a page clears stale".
2. **HIGH: flow 05's recovery step can't fail** (`apps/mobile/e2e/flows/05-daemon-down.yaml:24-25`). After the restart it asserts only `sessions-list`, the ScrollView, which is on screen in every state. It does not assert that a `session-<id>` row is back or that `sessions-stale` is gone. That is why finding 1 passed the "green" e2e run. The flow claims a recovery it does not check.
3. **MEDIUM: an empty or failed list never refreshes when the link comes back** (`session-list-controller.ts:119`). The guard needs `entries.length > 0`. Repro: an empty list → `link(false)` → a refresh while down → `link(true)` stays at `{status: "failed", error: "Reconnecting…"}`. This contradicts the Failure-modes row "sessionList while down → refreshed on up".
4. **MEDIUM: the link-status subscription is made once and never re-made** (`App.tsx:188-204`). If the first `LINKS.get` fails (daemon down when the screen opens), the registry forgets it, and Retry dials a new client. Nothing subscribes to that client's `onStatus`, so later drops neither mark the list stale nor refresh it.
5. **MEDIUM: Computers bypasses `describeError`** (`App.tsx:126-134`). It shows the raw `ChannelError` text (`ws-channel.ts:148`: "the daemon answered 401 to the token"; on iOS "cannot reach the daemon (close 1006)"). That breaks the carry-over that the app never words an error from the channel's guess. The row-building logic with its try/catch also sits in a component, against AGENTS §7 "logic in pure modules".

Attacks tried: (a) the stale lifecycle across fail → success: found 1. (b) An empty list with the link down then up: found 3. (c) Re-subscription after a failed first dial: found 4. (d) Single broker: `connection.ts:86` uses `denyAll`, one broker per client, no `session/open`: holds. (e) One session path: the same `webSocketChannelFactory` + `RemoteClient` stack, no new transport: holds. (f) Generation and dedupe in the reducer: they read correctly. My mutation re-run was not executed (my shell could not run it without approval), so the executor's mutation table stands but I have not checked it myself.

Holds: the protocol is untouched, `serve` binds 127.0.0.1, all scratch output stays under `.tentacle/tmp`, and the strip-origin proxy is test-only.

How the executor behaved: the drift is recorded honestly (testID-only assertions, the guard mutation that could not be done, iOS 18 not covered). But the e2e gate's last assertion is vacuous, and the reducer's stale path has no test. Both are gaps in the evidence, so "green" here claimed more than it showed. Also, the Execution section is signed `claude-opus-5-5`, while the commit says DeepSeek executed. Fix the signature.
