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
bun run e2e:mobile --ios 26 --only 24-ui-shots,18-photos # just these flows
```

`--only` is the same as `E2E_ONLY_FLOWS=…` (the flag wins when both are set).

## The gate (docs/feat/mobile-e2e-gate.md)

```sh
scripts/e2e-gate.sh <udid>                 # the WHOLE suite, unattended, on that simulator
scripts/e2e-gate.sh <udid> --app <x.app>   # install a ready simulator build instead of building
```

`--udid` (or `E2E_SIM_UDID`) names one simulator and therefore its iOS major: only
that simulator runs, it is booted if shut down, and the run never falls back to
another device. The app is uninstalled and installed ONCE per run; each flow
attempt is killed after `--flow-timeout` / `E2E_FLOW_TIMEOUT_S` seconds (default
600). The end is one table (`flow · result · seconds · tries`), also written to
`<runDir>/summary.txt` and `summary.json`; a failed flow keeps Maestro's
screenshots + `maestro.log` in `<runDir>/ios<major>/<flow>/`.

### Two simulators at once (docs/feat/e2e-parallel-gate.md)

```sh
scripts/e2e-gate.sh <udidA>,<udidB>        # the SAME suite, half the wall time
```

One Release build is installed on both; the flows are split between them by
their last recorded durations (from every finished run's `summary.json`), keeping
together the ones that read the same seeded session — 07 adds a turn to the
session 26 renames, so they cannot be separated. Each half gets its own `serve`,
mock model and Maestro device, so the halves cannot see each other. The end is
still ONE table and ONE exit code, in the same `FLOWS` order as a single run:

- `--only` runs on both; a shard with nothing to run simply starts nothing.
- A flow that a dead or crashed half never reported is RED, pointing at that
  half's dir — the gate never gets greener by running in parallel.
- `<runDir>/summary.txt` + `summary.json` are the merged result;
  `<runDir>/<sim-udid8>/` holds that half's artefacts and `<runDir>/<sim-udid8>.log`
  its output, every line tagged with its shard as a suffix (`✗ 07-prompt … [sim-0FA4B51F]`),
  so `grep '^✗'` and `awk '{print $2}'` still find the flow name.
- `Ctrl+C` on the parent stops both halves (and their Maestro drivers).

**The app cache.** A Release build is reused across runs when nothing it is
built from changed: the key is the content of every tracked app/package source
plus `xcodebuild -version` and the Bun version (the e2e harness, the flows and
unit tests are excluded — the bundle never imports them). A cached build lives
under `.tentacle/tmp/e2e-app-cache/<key>/` (shared by every worktree), the three
newest are kept, and a hit logs `app: cached <key12>`. A JS change is a new key,
because `apps/mobile/src` and `packages/*/src` are inputs. `--no-app-cache` (or
`E2E_NO_APP_CACHE=1`) forces a rebuild; a cache FAILURE never fails a gate.

Exit: `0` every counted flow passed · `1` a counted flow failed or timed out ·
`2` a missing prerequisite, a bad UDID or a tag without its reason · other = build.

**Tags** — in the flow's own header (before `---`), each with its reason line:

```yaml
appId: so.tentacle.app
tags:
  - known-bug
# known-bug: More → New session opens nothing (fix task: …)
---
```

| Tag | Effect |
|---|---|
| `flaky` | ONE retry; listed. Nothing untagged is ever retried. |
| `known-bug` | a real APP bug a fix task owns: runs, NOT counted, listed; a pass says "drop the tag" |
| `quarantine` | the FLOW cannot work today: not run, listed; needs a `TODO.md` line |

`test/e2e-gate.test.ts` refuses a tag with no reason and a known-bug/quarantine
with no `TODO.md` line (`e2e flow \`<name>\``).

**Before publishing an iOS build** (the orchestrator wires it): in the build
script, after the worktree is at the ref and before the upload,

```sh
$W/scripts/e2e-gate.sh <the build's own simulator udid> \
  || { echo "$(date +%H:%M) E2E GATE FAILED — see $W/.tentacle/tmp/e2e-mobile/" >> $L; exit 1; }
```

It builds its own simulator Release in `$W/apps/mobile` (`expo prebuild` is
idempotent, so `build.sh`'s device archive is unaffected) and never touches a
`serve` on port 4000.

**Nightly** (doc only — a `launchd` agent or `crontab -e` on the build Mac):

```sh
# 03:00 every night, from a dedicated worktree on main, a dedicated simulator
0 3 * * * cd $HOME/tentacle/.tentacle/worktrees/e2e-nightly && git fetch -q && git checkout -q --detach origin/main && bun install >/dev/null && scripts/e2e-gate.sh <udid> > .tentacle/tmp/e2e-nightly-$(date +\%F).log 2>&1 || osascript -e 'display notification "mobile e2e gate RED" with title "tentacle"'
```

The log's tail is the summary table; the run dir it names holds the evidence.

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
| `18-camera-denied.yaml` | camera denied → the card + Settings, and PASTE still pairs |
| `19-deep-link.yaml` | a `tentacle://pair?…` link lands on the review and claims nothing |
| `20-camera-close.yaml` | a granted Scan tap opens the preview, Close ends it, and paste still pairs |
| `18-lock-cold-start.yaml` | the lock is up at cold start; no content is reachable under it (F14); a Face ID match lets the person in |
| `19-lock-unlock-button.yaml` | `immediately` + background → the Unlock button is there and works (F5's reachable half) |
| `20-lock-immediately.yaml` | `immediately` locks the return AND the person lands where they were |
| `21-export-logs.yaml` | Settings → Export logs writes a file with no title/prompt/token in it (F16) |
| `_unlock.yaml` | (sub-flow) the lock at cold start + the scripted Face ID match; run after every `launchApp` |
| `22-notify-render.yaml` | a real sealed push arrives as a banner on its session's thread (task 17) |
| `22-notify-approve.yaml` | a notification's Approve asks Face ID ALWAYS, then `allow_once` reaches the daemon |
| `22-notify-deny.yaml` | Deny needs no authentication, raises no Face ID, and refuses the ask |
| `22-notify-reply.yaml` | Reply carries the person's words to the MODEL (the mock's prompt list) |
| `22-notify-forged.yaml` | a push sealed with a NON-pinned key answers NOTHING: the ask stays pending |
| `34-hub-<item>.yaml` | each hub fan / More item opens what it names (Attach, Activity, Artifacts, Tools, Commands, Sessions, Session info, Scheduled, Dictate, New session) |

11b.2's three flows (`18-camera-denied`, `19-deep-link`, `20-camera-close`) keep
11b.1's numbers because they were written first; the lock's flows keep THEIR
numbers (`18`–`21`) from `docs/feat/mobile-lock.md`. Two flows therefore share a
prefix, which is why the names carry the subject (`-camera-`, `-lock-`, `-deep-link`).

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

## Notifications on a REAL device (docs/feat/mobile-notifications.md D3)

The `22-notify-*` flows exercise the app's notification path on a simulator, with
the response INJECTED (`notify-respond`): Maestro cannot long-press a system
banner, and the Notification Service EXTENSION is a native target that exists only
in a device build. These are the items a simulator cannot prove, so they are
recorded here and checked by hand — after task 16's D2 (the APNs key on the relay
host) and D3a (below):

**D3a — Apple Developer console (owner only, before the first device build):**
1. Register the App ID `so.tentacle.app.NotificationService` (a Notification
   Service Extension).
2. Enable **Keychain Sharing** on BOTH `so.tentacle.app` and the extension's id,
   with the same group, and confirm the ORDER in `app.json` (its own group
   first — a device key must never land in the shared group; pinned by
   `apps/mobile/test/app-config.test.ts`).
3. Confirm **Time Sensitive Notifications** is on the app's id.
4. Regenerate the development and distribution provisioning profiles.

**D3 — the checklist (owner's iPhone, one line each, date recorded):**
- [ ] Long-press an ask's banner on the LOCK SCREEN: Approve / Deny / Reply / Open
      are all there (the categories registered at launch).
- [ ] Approve from the locked phone: the app opens, Face ID is asked, and the
      ask resolves `allow_once` (the TUI shows the tool running).
- [ ] Deny from the lock screen, no authentication prompt at all.
- [ ] Reply asks the DEVICE passcode/Face ID before accepting the text.
- [ ] Killed app, Deny over the LAN: resolved on the TUI within the budget
      (N0(d)); the same over `relay.tentacle.so`.
- [ ] Airplane mode, Deny: the "Couldn't reach <computer> — tap to answer" local
      notification appears, and tapping it opens the sheet with the ask.
- [ ] Time Sensitive breaks through a Focus mode; turn notices are grouped per
      session and are quiet.
- [ ] An ask answered at the desk after the push: the banner is replaced by
      "Answered on another device".
- [ ] A forged push (the harness's `seal-push?forged=1` against the owner's
      phone) shows the placeholder and answers nothing.

## Not in the gate

This harness needs a simulator, so `bun run check` does not run it. What *is* in
the gate: the pure halves — `test/e2e-preflight.test.ts` (missing tools and
runtimes are named), `test/e2e-flows.test.ts` (every flow asserts something
narrower than its container), and every module the app itself uses
(`pairing-e2e.test.ts` drives the whole pairing over real loopback sockets).
