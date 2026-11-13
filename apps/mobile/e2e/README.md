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
5. **Strip-origin proxy** — iOS always sends an `Origin`, which `serve` rejects
   until task 9's Origin policy. `e2e/strip-origin.ts` removes exactly that
   header; the app never imports it.
6. **Seed** — `Alpha` (finished turn), `Bravo` (closed → archived), `Charlie` (a
   `HOLD` turn left running).
7. **Build + install** a Release build with `EXPO_PUBLIC_TENTACLE_URL` pointing
   at the proxy.
8. **Maestro** — the flows in `flows/`, `clearState: true` per flow, JUnit and
   screenshots into the run dir.
9. **Teardown** in `finally` — every child killed, scratch kept for logs.

## Flows

| Flow | Asserts |
|---|---|
| `01-shell.yaml` | launches on `Computers`, shows `e2e-mac` and its project row |
| `02-session-list.yaml` | Active (`Charlie` running, `Alpha`) vs Archived (`Bravo`) |
| `03-refresh.yaml` | a hook creates `Delta`; pull-to-refresh shows it |
| `04-session-placeholder.yaml` | tapping a session opens the placeholder (no `session/open`); back keeps the list |
| `05-daemon-down.yaml` | a hook stops `serve` → "Can't connect"; restart → the sessions come back |

Flows 03 and 05 call the harness hook server through `runScript`
(`03-add-delta.js`, `05-stop-serve.js`, `05-start-serve.js`), using Maestro's
built-in `http.get`. `MAESTRO_HOOKS` is passed in the flow env.

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
runtimes are named) and `test/e2e-strip-origin.test.ts` (the byte-level rewrite),
plus every module the app itself uses.
