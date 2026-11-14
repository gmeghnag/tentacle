# `bun run e2e:mobile` — the mobile E2E harness

Decision 20 of `docs/eval/mobile-app.md`: this harness must pass **before any
mobile task merges**. Design and rationale: `docs/feat/mobile-app-shell.md`.

## Prerequisites (macOS only)

A missing piece is a **failure (exit 2)**, named with its install command — the
harness never silently skips.

| Tool | Install |
|---|---|
| Xcode + an iOS simulator runtime | App Store; `xcodebuild -downloadPlatform iOS -buildVersion 18.x` |
| CocoaPods | `brew install cocoapods` |
| Java 17 (Maestro needs a JDK) | `brew install openjdk@17` (keg-only; the harness sets `JAVA_HOME`) |
| Maestro | `brew install mobile-dev-inc/tap/maestro` |

Runtimes required: an **iOS 18.x** and an **iOS 26.x** simulator.

## Run

```sh
bun run e2e:mobile          # every required simulator (18 + 26)
bun run e2e:mobile --ios 26 # just one
```

## What it does

1. **Preflight** — macOS, Xcode, CocoaPods, Maestro, both runtimes.
2. **Scratch** — `<repo>/.tentacle/tmp/e2e-mobile/<runId>/` (never `/tmp`):
   `config/` (`TENTACLE_CONFIG_DIR`), `project/` (the `serve` cwd), logs.
3. **Mock model** — an OpenAI-style SSE endpoint on an ephemeral port; a prompt
   containing `HOLD` streams slowly, so a session stays visibly `running`.
4. **Real `serve`** from source, on `127.0.0.1` and a private config dir.
5. **Phone route** — the app dials `serve`'s own `/e2e` route (task 9), which
   admits a paired device key and tolerates iOS's `Origin`. There is **no proxy**
   any more: 11b.1 deleted `e2e/proxy.ts` / `e2e/strip-origin.ts` and the build
   env (11a's Owner Q4 carry-over).
6. **Pairing** — `tentacle pair` runs IN-PROCESS against that dir (`e2e/pairing.ts`:
   a pipe has no TTY, so the harness answers the `[y/N]`); every flow pairs the
   phone first, through the real payload line.
7. **Seed** — `Alpha` (finished turn), `Bravo` (closed → archived), `Charlie` (a
   `HOLD` turn left running).
8. **Build + install** a Release build with NO `EXPO_PUBLIC_TENTACLE_*` — the
   shippable one: the phone pairs at RUN time.
9. **Maestro** — the flows in `flows/`, `clearState: true` + `clearKeychain` per
   flow (Apple keeps Keychain items across an app delete), JUnit and screenshots
   into the run dir.
10. **Teardown** in `finally` — every child killed, any open pairing window
    answered `n`, scratch kept for logs.

## Flows

| Flow | Asserts |
|---|---|
| `01-shell.yaml` | `_pair` → `Computers` with the new computer's project row |
| `02-session-list.yaml` | Active (`Charlie` running, `Alpha`) vs Archived (`Bravo`) |
| `03-refresh.yaml` | a hook creates `Delta`; pull-to-refresh shows it |
| `05-daemon-down.yaml` | a hook stops `serve` → "Can't connect"; restart → the sessions come back |
| `12-pair-declined.yaml` | the human says `n` → `pair-error-declined`, nothing listed |
| `13-pair-expired.yaml` | a 1.5 s window elapses → `pair-error-expired` |
| `14-pair-bad-text.yaml` | garbage → `pair-error-invalid-payload`, and `pair` saw no claim |
| `15-revoked.yaml` | `/pair/revoke` → `computer-state-<id>-revoked` + Pair again |
| `16-remove-computer.yaml` | Remove → `Pair`, and a relaunch still has nothing |
| `17-persisted.yaml` | a relaunch (no clearState) re-reads the Keychain and the list loads |
| `18-lock-cold-start.yaml` | the lock is up at cold start; no content is reachable under it (F14); a Face ID match lets the person in |
| `19-lock-unlock-button.yaml` | `immediately` + background → the Unlock button is there and works (F5's reachable half) |
| `20-lock-immediately.yaml` | `immediately` locks the return AND the person lands where they were |
| `21-export-logs.yaml` | Settings → Export logs writes a file with no title/prompt/token in it (F16) |
| `_unlock.yaml` | (sub-flow) the lock at cold start + the scripted Face ID match; run after every `launchApp` |

## The lock and Face ID (docs/feat/mobile-lock.md Step 0)

The app locks at cold start (Owner Q1), so the harness drives the lock for real —
there is no test-only branch in app code.

| Hook | Does |
|---|---|
| `faceid-enroll` | enrols a face on the simulator (`notifyutil …enrollmentChanged`), idempotent |
| `faceid-match` | a matching face; the pending `authenticateAsync` resolves success |
| `faceid-nomatch` | **real device only** — the simulator's promise never resolves (Step 0) |
| `log-file` | reads the app's own `Documents/tentacle-log.txt` out of its container (flows 20 and 21) |

Two facts from Step 0 shape these flows: a `nomatch` cannot be scripted on the
simulator (the evaluation hangs, so no flow depends on a failing prompt — that
half of F5 is `app-lock.test.ts`'s), and JS timers keep running while the
simulator is backgrounded, so the 5-minute/1-hour delays are unit-tested and
device-checked, not flow-tested.

12c's session-screen flows (`06-session-open` … `11-disconnect-mid-turn`) run
last, each after `_pair`. Every flow that needs the world changed mid-run calls
the harness hook server through `runScript` (`03-add-delta.js`,
`05-stop-serve.js`, `pair-*.js`), using Maestro's built-in `http.get`.
`MAESTRO_HOOKS` is passed in the flow env.

`_pair.yaml` is the shared prefix: `/pair/start` opens a window in-process, the
flow pastes the payload line, the review confirms, `/pair/confirm` returns the
compare code the TERMINAL shows and the flow asserts the phone drew the same one,
then `/pair/answer` says `y`.

## Running one flow by hand

```sh
JAVA_HOME=$(brew --prefix openjdk@17) PATH="$(brew --prefix openjdk@17)/bin:$PATH" \
  maestro --device "iPhone 17 Pro" test apps/mobile/e2e/flows/01-shell.yaml
```

A hand-run needs a daemon and a build already pointed at it; the harness is what
sets those up.

## Not in the gate

This harness needs a simulator, so `bun run check` does not run it. What *is* in
the gate: the pure halves — `test/e2e-preflight.test.ts` (missing tools and
runtimes are named), `test/e2e-flows.test.ts` (every flow asserts something
narrower than its container), and every module the app itself uses
(`pairing-e2e.test.ts` drives the whole pairing over real loopback sockets).
