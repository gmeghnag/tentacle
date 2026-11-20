# fix/mobile-e2e-reds — Triage the mobile e2e gate's reds (+ fix/mobile-hub-new-session)

> **Status:** review
> **Branch:** `fix/mobile-e2e-reds` (also covers `fix/mobile-hub-new-session`, owner 2026-11-19: one branch)
> Type: fix · Size: M · Blast: contained · Suited: Opus
> **Changelog:** `changelog.d/mobile-hub-new-session.fixed.md` (hub New session) · `changelog.d/mobile-e2e-reds.fixed.md` (offline outbox + VoiceOver switches)

## Context

*— claude-opus-5-5, 2026-11-19*

`scripts/e2e-gate.sh <udid>` (docs/feat/mobile-e2e-gate.md) is merged but is NOT
the iOS-publish gate: its full run is red (Review Round 3 F4, "Owner decision"
2026-11-19). Reported: `05-daemon-down` passes alone but fails in the suite;
`33-hub` + the `34-hub-*` flows fail even alone; `34-hub-commands` is still tagged
`known-bug` from before the Commands sheet (C3). Separately the owner, on a real
iPhone: hub → More → **New session** no longer opens a new session (its flow is
`34-hub-new`).

The task: evidence first (one full gate run on a dedicated simulator, then each
red alone), decide PRODUCT vs FLOW/harness per red, fix product bugs in pure
modules with red-before-green tests, fix flow/harness bugs in the flows/harness,
quarantine only as a last resort. Exit: TWO consecutive full gate runs exit 0.
Wiring the gate into a publish script is the orchestrator's, after merge.

**Repro (2026-11-19, iPhone 17 Pro Max iOS 26, UDID 0B43D716…, ephemeral ports):**
`scripts/e2e-gate.sh 0B43D716-9670-421A-BE51-9162004F2963` on `main` @ 81e59f6b →
`GATE FAIL — 34 passed, 25 failed, 0 known-bug, 0 quarantined (of 60; 3796 s)`
(run `1795081790662`; full table in Execution).

## Implementation

*— claude-opus-5-5, 2026-11-19*

A triage task: the plan was the evidence loop (§1) — per red, the failing step
(`commands.json`), the screenshot and `maestro.log`, one hypothesis, the cheapest
test. Each fix below names its evidence.

### Load-bearing assumption

A red is a PRODUCT bug only when the screenshot/hierarchy shows the app doing the
wrong thing to a person; a red caused by Maestro/harness mechanics (timing,
accessibility grouping, Android-only commands, list length across flows, hook
plumbing) is fixed in the flow/harness and never by bending the app.

### Preconditions

- Every port is ephemeral (`apps/mobile/e2e/run.ts:11`): the run never touches the owner's `serve` on 4000.
- Flows are read by Maestro per attempt, so a flow edited after it ran does not change that run's evidence.

### Design / Files

Product (pure modules + tests, §7/§9):

- `src/drawer-new-session.ts` `newSessionFromHub` + `App.tsx` wiring — hub New session.
- `src/compose-controller.ts` `offlineBasis`/`primeBasis` — Send later never waits on the link.
- `src/session-screen-controller.ts` `link(up)` → `compose.runOutbox()` — the outbox runs at `up`.
- `src/session-screen-controller.ts` `link(up)` already listed; `src/row-value.ts` `rowAccessibility` + `src/ui/Row.tsx` — a trailing control is always its own element, a pressable row's action rides on its label.
- `src/activity.ts` `nothingRunning` + `SessionScreen.tsx` `activityEmpty` — an Activity holding only Scheduled's empty state is "Nothing running".

Harness: `e2e/mock-model.ts` (`GATED`), `e2e/hooks.ts` (`model-release`, `laptop-offline-turn`,
`idleTimeout: 0`, complete `queryOf`), `e2e/run.ts` (push token, side `serve` on a free port),
`e2e/seed.ts` (`pendingAsks` attaches, `turnOnce`), `e2e/escape-probes.ts` (nameless hits
need a WebKit agent; strays reported). Flows: see the table.

### Failure modes

- Hub New session offline → the drawer opens and says why (never a silent no-op); a probe that throws reads as offline; a create that fails opens the drawer with its error.
- Send later with no basis read yet → `{0, null}` → `decide` says "changed" → the person is asked; never lost.
- `runOutbox` at `up` racing the attach's run → the driver serialises runs per session and a `busy` set never picks one item twice (`outbox-driver.ts:210-217,452`).

### Tests

Each red first on the buggy code, then green (Execution lists them).

## Execution

*— claude-opus-5-5, 2026-11-19*

### Triage (run 1 = `1795081790662`, full suite on `main`; then each red alone / targeted)

| Flow | Evidence (failing step → what the screen/log showed) | Verdict | Fix |
|---|---|---|---|
| `34-hub-new` | `hub-menu-new` tapped → same session, no navigation, no error. `canCreate` = the drawer title's probe, which runs only while the drawer is open (`App.tsx` `loadRows` effect on `drawer.open`) → `fresh.start(listed, false)` returned silently | **PRODUCT** (the owner's regression) | `newSessionFromHub`: probe now, create+open, else open the drawer. Test `drawer-new-session.test.ts` (4 cases, red first). Targeted run: PASS |
| `16-offline-outbox`, `17-outbox-changed` | Send later → field cleared, NO outbox row, no `waiting-network`. `press` awaited `basis()` → `client.snapshot` → `whenLive` (waits for the link) after `takeField` | **PRODUCT** (text in no place until reconnect; a kill lost it) | `offlineBasis()` (last basis read, primed at start/turn end). Test `compose-controller.test.ts` "Send later while the link is down never waits on it" (red: hung) |
| `17-outbox-changed` (after the above) | phone reconnected (laptop turn on screen) but the item stayed `waiting`, no decision sheet: `runOutbox` only at attach | **PRODUCT** (13b's "run at `up`" not wired) | `link(up)` runs the outbox. Test `session-screen-compose.test.ts` "the link coming back RUNS the outbox" (red: `sent` = []) |
| `17-outbox-changed` | `laptop-prompt` hook → "unexpected end of stream" after 20 s; run log "Bun.serve() timed out a request after 10 seconds" | HARNESS | hooks server `idleTimeout: 0` |
| `34-hub-dictate` | `beta-dictation` not found; hierarchy: one element "Dictation, Dictation", `enabled: false` — the Row (a Pressable with no action) swallowed the switch | **PRODUCT** (VoiceOver could not reach Settings switches) | `rowGroupsForAccessibility`: a row whose only control is a trailing one does not group. Test `row-value.test.ts` (red: missing). Targeted: PASS |
| `12-steer` | the 20 s `STEADY` turn ended before Maestro's tap+type+send (13.7 s for one tap) → the steer became a new turn | HARNESS (timer race) | mock `GATED` turn, released by `model-release` after the queue; `e2e-mock-gated.test.ts`. Targeted: PASS |
| `13-send-now` | HOLD (120 s) started at 619.3 s; send-now tap 735.9–741.0 s → the turn ended mid-tap | HARNESS (timer race) | `GATED` (ends only on the send-now's abort; abort opens the gate — mutation-checked). Targeted: PASS |
| `23-composer-keyboard` | the SLOW turn (~4.5 s) ended inside the 5.7 s tap → `turn-running` never seen; the message WAS sent | FLOW | assert the field emptied (`composer-filled` gone); `23-history.js` proves the model was asked |
| `24-ui-shots`, `21-export-logs` | `export-logs` below the fold (the opacity band grew Settings) | FLOW | `scrollUntilVisible` (+ scroll back up to `settings-back`) |
| `25-session-info` | Skills below the fold (Scheduled wakes section), asserted before the scroll | FLOW | the scroll is the assertion |
| `26-drawer`, `24-ui-shots` | `drawer-scrim` not found: it sits under the open drawer's `accessibilityElementsHidden` content (VoiceOver closes with Escape — by design) | FLOW | tap the scrim by point (90 %, 50 %) |
| `27-activity`, `34-hub-activity` | `text: "long child"` — the row's accessible text is the whole label `long child, sa-1 · …` (full-regex match) | FLOW | prefix regex `long child,.*` |
| `33-hub`, `34-hub-activity` | `hub-glyph` / `hub-badge-count` not found: the hub is ONE accessible element (by design) | FLOW | assert `floating-activity` with its label (`Tentacle hub` / `Tentacle hub, N running.*`) |
| `34-hub-artifacts`, `34-hub-tools` | `text: "Hub notes"` / `"demo"` — whole-label rows | FLOW | assert by id (`artifact-gallery-row-hubnotes`, `tools-mcp:demo`) |
| `19-lock-unlock-button`, `20-lock-immediately`, `21-export-logs`, `push-placeholder`, `22-notify-render` | `back` = Maestro's Android key, a no-op on iOS (left the flow on Settings / the list); `launchApp` stops the app by default → a cold start | FLOW | `settings-back`/`sessions-back`; `launchApp: stopApp: false`. 20 + 21 targeted: PASS |
| `19-lock-unlock-button` (after the above) | a resume with the lock up auto-prompts Face ID BY DESIGN (`app-lock.ts` `returnToActive`); the system sheet covers `lock-unlock`, and a nomatch cannot be scripted (Step 0) | FLOW cannot work on the simulator | **quarantined** (reason in its header + TODO line); logic in `app-lock.test.ts` |
| `22-relay-only`, `22-notify-*`, every `session-${…}` tap | in the full suite every earlier flow's session sits above the seeded one (newest first) → below the fold (passes alone) | FLOW (state carried across the suite — the "05 passes alone" class) | `scrollUntilVisible` before every list tap on `session-${…}` (46 places) |
| `push-placeholder` | `push-place` → 500 "the daemon answered 401 to the token": `promptOnce` dialled `serve` without the token | HARNESS | pass the seed's `endpoint` (url + token) |
| `22-notify-approve/-deny/-reply/-forged` | `pending-ask` → "no pending ask" with the sheet up: the laptop peer reads its router, but nothing attached it to `ASK1`; then `notify-respond` → 400 "action is required": `queryOf` read 7 of 13 declared params | HARNESS | `pendingAsks` attaches first (bounded wait for the replay); `queryOf` reads every `HookQuery` key (one list + a compile-time completeness check, mutation-checked); `e2e-hooks-query.test.ts` (red first) |
| `22-notify-approve/-deny/-reply/-forged` (after the above, run ALONE) | the injected response never reaches the app: no Face ID sheet, the ask stays pending (screenshot), then deny/reply/forged open onto that leftover sheet. `notify-respond` writes a file the app reads only `if (__DEV__)` (`App.tsx`, Owner Q7: never in the shipped build); the gate installs the Release | FLOW cannot work against the gate's Release build (by design) | **quarantined** ×4 (reason + TODO lines) — needs a dev-build lane |
| `17-outbox-changed` (run 2) | with the outbox now running at `up`, the phone reconnected (full-jitter backoff from 500 ms, `link-machine.ts`) BEFORE the laptop's turn and sent the item as unchanged — correct behaviour, racy flow | FLOW (race) | the laptop's turn runs on a SIDE `serve` (same store, a port the phone does not know) while the phone is offline: new `laptop-offline-turn` hook + `turnOnce` |
| `25-session-info` (run 2) | `session-info-mcp-demo-switch` never found; `scrollUntilVisible UP` then swiped the sheet closed. The MCP row is pressable (opens its tools) AND has a switch: grouped, the switch was unreachable | **PRODUCT** (VoiceOver could not switch a server in Session info) | `rowAccessibility`: a trailing control is always its own element; a pressable row with one keeps its action on the label column (`onAccessibilityTap`). `row-value.test.ts` |
| `33-hub` (run 2) | Activity tapped with nothing running → a sheet with only "Scheduled · No scheduled wakes" instead of "Nothing running" inline. `activityEmpty = groups.length === 0`, and the wake feed (mobile-qa-sweep) always adds an empty Scheduled group | **PRODUCT** (mobile-hub-tap Design 2 regression) | `ActivityView.nothingRunning` (no group has rows) → the hub's `activityEmpty`. `activity.test.ts` (red first); `hub-tap-wiring.test.ts` updated |
| `19-deep-link` (run 2) | iOS's `Open in "tentacle"?` did not appear on the second run on the same simulator (it kept the answer); the review opened directly | FLOW (simulator state) | the `Open` tap is `optional`; the review is the assertion |
| `22-relay-only` (run 2) | after `pressKey: home` + `launchApp` (a cold start) the lock is up, `computers-list` under it | FLOW | `_unlock` after the relaunch |
| `17-outbox-changed` (run 3) | the text went back to the FIELD (no sheet); the side `serve`'s log: `device-open` — the phone reached the side `serve` through the RELAY (its pairing carries the relay address too) | HARNESS | the side `serve` runs `--no-relay` |
| `25-session-info` (run 3) | the rename field opens with the current title; typing appended: `composeRenamed by flow 25` | FLOW | `eraseText` before typing |
| `33-hub` (run 3) | Settings reopened from the drawer starts at its top: `hub-opacity-slider` below the fold | FLOW | scroll to the band, then back up to `settings-back` |
| `22-relay-only` (run 3) | `relay-qr` → "0 addresses": `lastPayload` took EVERY line `pair` printed, so it held the final `Paired 'iPhone' …` line | HARNESS | only a `tentacle://` line is the payload; `e2e-pairing.test.ts` asserts it after a full pairing (red first) |
| `17-outbox-changed` (run 4) | the outbox now decides "changed" (no relay to the side `serve`); the row reads "Needs your answer" — the decision sheet opens on a TAP on that row (current compose UX), never by itself | FLOW | wait for `outbox-row-.*-needs-decision`, tap it, then `outbox-decision` |
| `27-activity` (run 4) | the detail opened (8 s tap) when the child was at step 24: `step-4` folded into "… 19 earlier" | FLOW (timing) | any `step-N.txt` row proves the list is live |
| `33-hub` (run 4) | `swipe RIGHT` from the slider (thumb at 20 %) popped Settings back to the session — iOS 26's content back-swipe | FLOW (+ a device check in TODO.md: a real rightward drag may do the same — unverified) | tap the 100 % mark: the track's grant sets the value at the touch |
| `push-placeholder`, `22-notify-render` | the banner was never found. Probe: a PLAIN `simctl push` banner, on screen (screenshots `bg.png`/`fg.png`: shown foreground and background) during a 20 s `extendedWaitUntil`, was not found by Maestro either | FLOW cannot work (Maestro does not read SpringBoard banners on iOS 26) | **quarantined** (reason + TODO lines); the banner stays on README's device checklist (D3) |
| `30-artifact-escape` | suite only: `ESCAPED: ["unnamed"]` with scripts OFF; alone: PASS. With the path recorded, run 2 said `unnamed POST /mcp` — an MCP-over-HTTP client, which a scripts-off WebView cannot be and the harness never configures: another local process probing ports | HARNESS (noise on an ephemeral port) | a nameless request counts only with a WebKit user agent (every WebView request has one); others are `strays`, reported, never counted. `e2e-escape-probes.test.ts` (red first). A NAMED probe counts whatever its agent |
| `05-daemon-down` | PASSED in the suite in run 1 (reported red in-suite before) | — | covered by the list-scroll fix; see runs 2–3 |
| `34-hub-commands` | PASS (tagged `known-bug`) | — | tag + TODO sub-line dropped |

### Run 1 summary (`main` @ 81e59f6b)

```
GATE FAIL — 34 passed, 25 failed, 0 known-bug, 0 quarantined (of 60; 3796 s)
```
(failed: 12-steer, 13-send-now, 16-offline-outbox, 17-outbox-changed, 23-composer-keyboard, 24-ui-shots, 25-session-info, 26-drawer, 27-activity, 30-artifact-escape, 33-hub, 34-hub-artifacts, 34-hub-tools, 34-hub-dictate, 34-hub-new, 19-lock-unlock-button, 20-lock-immediately, 21-export-logs, 22-relay-only, push-placeholder, 22-notify-render/-approve/-deny/-reply/-forged; known-bug 34-hub-commands passed)

### Full runs after the fixes

Each run found the next layer (a fix lets a flow get further); every red was triaged above.

| Run | Result |
|---|---|
| 2 | `GATE FAIL — 47 passed, 10 failed, 0 known-bug, 3 quarantined (of 60; 3961 s)` |
| 3 | `GATE FAIL — 49 passed, 4 failed, 0 known-bug, 7 quarantined (of 60; 3645 s)` |
| 4 | `GATE FAIL — 50 passed, 3 failed, 0 known-bug, 7 quarantined (of 60; 3582 s)` |
| 5 | `GATE FAIL — 52 passed, 1 failed, 0 known-bug, 7 quarantined (of 60; 3629 s)` (33-hub; fixed, then `--only 33-hub`: PASS) |

Quarantined (7, each with its reason in the flow header and a `TODO.md` line):
`19-lock-unlock-button` (Face ID auto-prompt covers the button; nomatch unscriptable),
`push-placeholder` + `22-notify-render` (Maestro cannot read SpringBoard banners on iOS 26),
`22-notify-approve/-deny/-reply/-forged` (the response injection is DEV-build only; the gate runs Release).

**Exit criterion — two consecutive full runs, exit 0** (`scripts/e2e-gate.sh 0B43D716-9670-421A-BE51-9162004F2963`, each building its own Release; run 7 started right after run 6, no change in between):

Run 6 (`1795134162559`, EXIT 0):

```
flow                    result       seconds  tries
----------------------  -----------  -------  -----
01-shell                PASS         42       1
02-session-list         PASS         59       1
03-refresh              PASS         58       1
05-daemon-down          PASS         74       1
12-pair-declined        PASS         38       1
13-pair-expired         PASS         34       1
14-pair-bad-text        PASS         39       1
15-revoked              PASS         74       1
16-remove-computer      PASS         77       1
17-persisted            PASS         57       1
18-camera-denied        PASS         55       1
19-deep-link            PASS         42       1
20-camera-close         PASS         71       1
06-session-open         PASS         69       1
07-prompt               PASS         95       1
08-permission           PASS         77       1
08b-permission-deny     PASS         57       1
08c-permission-reply    PASS         69       1
09-foreign-turn         PASS         53       1
10-background-ask       PASS         73       1
11-disconnect-mid-turn  PASS         76       1
12-steer                PASS         152      1
13-send-now             PASS         172      1
14-returned-mine        PASS         141      1
15-returned-other       PASS         47       1
16-offline-outbox       PASS         77       1
17-outbox-changed       PASS         56       1
18-photos               PASS         61       1
23-composer-keyboard    PASS         68       1
24-ui-shots             PASS         126      1
25-session-info         PASS         78       1
26-drawer               PASS         80       1
27-activity             PASS         175      1
28-floating-activity    PASS         95       1
29-tool-rows            PASS         101      1
30-artifact-escape      PASS         53       1
31-chart-inline         PASS         73       1
32-chart-interact       PASS         62       1
33-hub                  PASS         239      1
34-hub-attach           PASS         48       1
34-hub-activity         PASS         57       1
34-hub-artifacts        PASS         46       1
34-hub-tools            PASS         45       1
34-hub-commands         PASS         45       1
34-hub-sessions         PASS         46       1
34-hub-info             PASS         46       1
34-hub-scheduled        PASS         58       1
34-hub-dictate          PASS         64       1
34-hub-new              PASS         56       1
18-lock-cold-start      PASS         45       1
19-lock-unlock-button   QUARANTINED  -        -
20-lock-immediately     PASS         48       1
21-export-logs          PASS         52       1
22-relay-only           PASS         72       1
push-placeholder        QUARANTINED  -        -
22-notify-render        QUARANTINED  -        -
22-notify-approve       QUARANTINED  -        -
22-notify-deny          QUARANTINED  -        -
22-notify-reply         QUARANTINED  -        -
22-notify-forged        QUARANTINED  -        -

GATE PASS — 53 passed, 0 failed, 0 known-bug, 7 quarantined (of 60; 3872 s)

Quarantined (not run):
  19-lock-unlock-button — a resume with the lock up auto-prompts Face ID by design (app-lock.ts `resumed`), so the system sheet always covers `lock-unlock`, and a nomatch cannot be scripted on the simulator (it never resolves, Step 0) — the button cannot be reached here; its logic is app-lock.test.ts's (docs/fix/mobile-e2e-reds.md)
  push-placeholder — Maestro cannot see a SpringBoard notification banner on the iOS 26 simulator — a plain `simctl push` banner, on screen during a 20 s `extendedWaitUntil`, was never found (docs/fix/mobile-e2e-reds.md); the banner is checked by hand (README D3) until Maestro can read it
  22-notify-render — Maestro cannot see a SpringBoard notification banner on the iOS 26 simulator — a plain `simctl push` banner, on screen during a 20 s `extendedWaitUntil`, was never found (docs/fix/mobile-e2e-reds.md); the banner is checked by hand (README D3) until Maestro can read it
  22-notify-approve — `notify-respond` injects the response through a file the app reads in DEV builds only (App.tsx `if (__DEV__)`, Owner Q7: never in the shipped build), and the gate installs the shippable Release, so the injected action never reaches the app (docs/fix/mobile-e2e-reds.md); run it against a dev build, or on a device (README D3)
  22-notify-deny — `notify-respond` injects the response through a file the app reads in DEV builds only (App.tsx `if (__DEV__)`, Owner Q7: never in the shipped build), and the gate installs the shippable Release, so the injected action never reaches the app (docs/fix/mobile-e2e-reds.md); run it against a dev build, or on a device (README D3)
  22-notify-reply — `notify-respond` injects the response through a file the app reads in DEV builds only (App.tsx `if (__DEV__)`, Owner Q7: never in the shipped build), and the gate installs the shippable Release, so the injected action never reaches the app (docs/fix/mobile-e2e-reds.md); run it against a dev build, or on a device (README D3)
  22-notify-forged — `notify-respond` injects the response through a file the app reads in DEV builds only (App.tsx `if (__DEV__)`, Owner Q7: never in the shipped build), and the gate installs the shippable Release, so the injected action never reaches the app (docs/fix/mobile-e2e-reds.md); run it against a dev build, or on a device (README D3)
```

Run 7 (`1795138361914`, EXIT 0):

```
flow                    result       seconds  tries
----------------------  -----------  -------  -----
01-shell                PASS         40       1
02-session-list         PASS         41       1
03-refresh              PASS         42       1
05-daemon-down          PASS         74       1
12-pair-declined        PASS         38       1
13-pair-expired         PASS         34       1
14-pair-bad-text        PASS         33       1
15-revoked              PASS         51       1
16-remove-computer      PASS         55       1
17-persisted            PASS         53       1
18-camera-denied        PASS         54       1
19-deep-link            PASS         30       1
20-camera-close         PASS         52       1
06-session-open         PASS         45       1
07-prompt               PASS         71       1
08-permission           PASS         61       1
08b-permission-deny     PASS         52       1
08c-permission-reply    PASS         61       1
09-foreign-turn         PASS         51       1
10-background-ask       PASS         60       1
11-disconnect-mid-turn  PASS         51       1
12-steer                PASS         149      1
13-send-now             PASS         169      1
14-returned-mine        PASS         116      1
15-returned-other       PASS         44       1
16-offline-outbox       PASS         77       1
17-outbox-changed       PASS         56       1
18-photos               PASS         61       1
23-composer-keyboard    PASS         68       1
24-ui-shots             PASS         134      1
25-session-info         PASS         78       1
26-drawer               PASS         80       1
27-activity             PASS         160      1
28-floating-activity    PASS         93       1
29-tool-rows            PASS         100      1
30-artifact-escape      PASS         53       1
31-chart-inline         PASS         74       1
32-chart-interact       PASS         62       1
33-hub                  PASS         241      1
34-hub-attach           PASS         48       1
34-hub-activity         PASS         57       1
34-hub-artifacts        PASS         46       1
34-hub-tools            PASS         45       1
34-hub-commands         PASS         45       1
34-hub-sessions         PASS         46       1
34-hub-info             PASS         47       1
34-hub-scheduled        PASS         59       1
34-hub-dictate          PASS         64       1
34-hub-new              PASS         56       1
18-lock-cold-start      PASS         46       1
19-lock-unlock-button   QUARANTINED  -        -
20-lock-immediately     PASS         48       1
21-export-logs          PASS         53       1
22-relay-only           PASS         72       1
push-placeholder        QUARANTINED  -        -
22-notify-render        QUARANTINED  -        -
22-notify-approve       QUARANTINED  -        -
22-notify-deny          QUARANTINED  -        -
22-notify-reply         QUARANTINED  -        -
22-notify-forged        QUARANTINED  -        -

GATE PASS — 53 passed, 0 failed, 0 known-bug, 7 quarantined (of 60; 3598 s)

Quarantined (not run):
  19-lock-unlock-button — a resume with the lock up auto-prompts Face ID by design (app-lock.ts `resumed`), so the system sheet always covers `lock-unlock`, and a nomatch cannot be scripted on the simulator (it never resolves, Step 0) — the button cannot be reached here; its logic is app-lock.test.ts's (docs/fix/mobile-e2e-reds.md)
  push-placeholder — Maestro cannot see a SpringBoard notification banner on the iOS 26 simulator — a plain `simctl push` banner, on screen during a 20 s `extendedWaitUntil`, was never found (docs/fix/mobile-e2e-reds.md); the banner is checked by hand (README D3) until Maestro can read it
  22-notify-render — Maestro cannot see a SpringBoard notification banner on the iOS 26 simulator — a plain `simctl push` banner, on screen during a 20 s `extendedWaitUntil`, was never found (docs/fix/mobile-e2e-reds.md); the banner is checked by hand (README D3) until Maestro can read it
  22-notify-approve — `notify-respond` injects the response through a file the app reads in DEV builds only (App.tsx `if (__DEV__)`, Owner Q7: never in the shipped build), and the gate installs the shippable Release, so the injected action never reaches the app (docs/fix/mobile-e2e-reds.md); run it against a dev build, or on a device (README D3)
  22-notify-deny — `notify-respond` injects the response through a file the app reads in DEV builds only (App.tsx `if (__DEV__)`, Owner Q7: never in the shipped build), and the gate installs the shippable Release, so the injected action never reaches the app (docs/fix/mobile-e2e-reds.md); run it against a dev build, or on a device (README D3)
  22-notify-reply — `notify-respond` injects the response through a file the app reads in DEV builds only (App.tsx `if (__DEV__)`, Owner Q7: never in the shipped build), and the gate installs the shippable Release, so the injected action never reaches the app (docs/fix/mobile-e2e-reds.md); run it against a dev build, or on a device (README D3)
  22-notify-forged — `notify-respond` injects the response through a file the app reads in DEV builds only (App.tsx `if (__DEV__)`, Owner Q7: never in the shipped build), and the gate installs the shippable Release, so the injected action never reaches the app (docs/fix/mobile-e2e-reds.md); run it against a dev build, or on a device (README D3)
```

### Fix round 1

*— claude-opus-5-5, 2026-11-20*

**MEDIUM fixed: `Row.tsx` treated ANY defined `trailing` as a control.** Root cause:
`rowAccessibility({ control: trailing !== undefined })` — "is something there"
answers a different question from "is it something the person ACTS on". A `ReactNode`
cannot be classified from the component (Session info's `values` and its `delete` are
both a `View`; Commands' one edge slot is a `<Text>` reason for a dimmed row and a
two-button `View` for a running one), so the distinction moved to a declared
`trailingKind`, and to the pure module that knows each caller's states:

- `row-value.ts:126` `RowTrailing = "none" | "value" | "control"` and `:139`
  `rowTrailing(trailing, declared)`: an ABSENT edge (`undefined` **or `null`**) is
  `none` whatever the caller said; otherwise the declaration stands, with `control`
  as the floor — for an undeclared element and for a caller that says `none` while
  passing one. Swallowing an actionable control is the worse failure (the original
  bug: a disabled "Dictation, Dictation" VoiceOver and XCUITest cannot reach), while
  a value wrongly called a control only splits one read in two.
- `row-value.ts:159` `rowAccessibility` now takes `trailing: RowTrailing`, not
  `control: boolean` — it can no longer be asked the wrong question.
- `ui/Row.tsx:80` the new `trailingKind` prop, `:169` the pure decision.
- `session-commands.ts:177` `commandEdge(state, id)` — the Commands sheet's own
  classification (its one edge slot has seven shapes): `ready`/`confirming` → `none`,
  a dimmed reason and `Compacted ✓` → `value`, a running CLEAR's `Clearing…` →
  `value`, a running COMPACT (it carries Stop), a failure (Retry), Clear's confirm
  and Auto-accept's switch → `control`.
- Callers that now say what their edge is: `CommandsSheet.tsx:265,282` (its own
  `commandEdge`), `SessionInfoSheet.tsx:244` (`control` when the row has a switch or
  a Delete, `value` for the plain `values` read), `SettingsScreen.tsx:229,293,427,480,522`
  (a checkmark is a READ of the stored choice, so the choice rows stay one element —
  the fix for Review (a)(b)(c) beyond the sheets). `ToolsSheet.tsx` needed nothing:
  its `null` is now `none` by the pure rule, and its only real edge is a switch.

**Red before green** — `apps/mobile/test/row-a11y.test.ts` (new; renders the real
element tree with `react-native`/`expo-symbols`/`react-native-safe-area-context` as
host stubs, the `session-info-schedules-render.test.ts` pattern) + new cases in
`row-value.test.ts` and `session-commands.test.ts`. On the pre-fix code (the old
`control: trailing !== undefined`), the new file: `5 pass · 4 fail`, every fail on an
assertion, none on an import:
`trailing VALUE … read together` (`Expected: true / Received: false`), `a null
trailing is no trailing at all`, `a ready Commands row is ONE element`, `a dimmed
row's reason is read WITH the row`. After the fix all are green.

The Tools band's `null` edge is the one case whose component test cannot be rendered
in the same file (`ToolsSheet.tsx` imports `RefreshControl`/`TextInput` while
`CommandsSheet.tsx` needs `ActivityIndicator`, and Bun's `mock.module` is
process-wide — the same pre-existing trap as `commands-sheet` +
`session-info-schedules-render`). It is pinned in `row-value.test.ts` instead, on the
sheet's exact call (`rowTrailing(null, undefined) === "none"`);
`ToolsSheet.tsx:78` itself is unchanged by this branch (`git diff main --` empty),
which is the point: the pure rule had to fix it, not the sheet.

**Mutation non-vacuity** (each mutated, run, reverted; tree re-checked with
`git diff --stat` after every one):

| Mutation | Witness |
|---|---|
| `rowTrailing`: drop the declaration (`return "control"`) | `4 fail` — row-a11y ×4 (the value/null/ready/dimmed cases) |
| `rowTrailing`: drop the `null` guard (`if (trailing === undefined)`) | `3 fail` — `a null trailing is no trailing at all` + the ready Commands row + (on `row-value.test.ts`) the Tools call `rowTrailing(null, undefined)` |
| `Row.tsx`: back to `trailing !== undefined ? "control" : "none"` | `5 fail` — row-a11y, incl. the Session info `Model` row |
| `SessionInfoSheet`: `trailingKind` hard-wired to `"value"` | `1 fail` — `a row that shows a value AND switches is split` (its MCP switch swallowed) |
| `commandEdge`: a running row always `"value"` | `3 fail` — `commandEdge` ×2 + `a running row's Stop is its own element` |

**One drift from the Review's suggested shape**, deliberate: the Review offered
`trailingControl` (a boolean) or `trailingKind`. A boolean still cannot express
`none` vs `value` distinctly at the boundary the bug was about, and the absent case
must be `none` even when the caller passes the prop unconditionally (Commands'
`edgeFor` is `null` on every ready row, so `trailingControl` would have had to be
computed per state anyway) — so the pure rule owns the whole three-way
classification and `Row` only forwards it.

**Tests run:** `apps/mobile/test` whole (267 files) → `3937 pass · 0 fail · 15722
expect() calls`; `bunx tsc -p apps/mobile --noEmit` → 0; `bunx biome check` on the 9
touched source/test files → `No fixes applied`. The full repo gate is the orchestrator's.
Known harness artifact, NOT this diff: running `commands-sheet.test.ts` together with
`session-info-schedules-render.test.ts` fails the former on `Export named
'ActivityIndicator' not found` — `mock.module` is process-wide and the latter's
stub omits it; both files are untouched by this branch (`git diff main --` empty) and
either runs green with its own sibling set.

### Gate

- `bunx tsc --noEmit` → 0 · `bunx tsc -p apps/mobile --noEmit` → 0 · `bun run lint` → `Checked 2122 files … No fixes applied.`
- `bun test` (one full run, tail): `15668 pass · 5 skip · 0 fail · Ran 15673 tests across 1113 files` — the 5 skips are pre-existing (this diff adds none). An earlier full run had two fails in `packages/cli/test/serve-mcp.test.ts` T12 (outside this diff); the rerun was clean (timing-flaky, not this task's).
- Red-before-green tests (each shown failing on the buggy code): `drawer-new-session.test.ts` (newSessionFromHub ×4), `compose-controller.test.ts` (Send later never waits), `session-screen-compose.test.ts` (outbox runs at `up`), `row-value.test.ts` (rowAccessibility), `activity.test.ts` (nothingRunning), `e2e-mock-gated.test.ts` (GATED; abort case mutation-checked), `e2e-hooks-query.test.ts` (queryOf; completeness check mutation-checked with tsc), `e2e-escape-probes.test.ts` (strays), `e2e-pairing.test.ts` (lastPayload).

### Drift from the brief

- Seven flows are quarantined, not fixed — each because the flow cannot work against the gate as designed (Face ID auto-prompt over the button; Maestro cannot read SpringBoard banners on iOS 26; the response injection is DEV-only and the gate runs Release). Each has its reason in the flow header and a `TODO.md` line.
- Product fixes beyond New session (found by the triage, all `contained`, pure module + test): Send later offline, outbox at `up`, Row accessibility (Settings + Session info switches), Activity "Nothing running".
- One unverified product suspicion recorded, not fixed: a rightward drag on the hub-opacity track may trigger iOS 26's content back-swipe (TODO.md device check).
- Not wired into any publish script (the orchestrator's, after merge).

## Review

*— claude-opus-5-5, 2026-11-20*

**Verdict: REQUEST-CHANGES** (one MEDIUM; everything else holds).

Gate (this review): the 10 touched mobile test files → `176 pass · 0 fail`; `bun run lint` → `Checked 2122 files … No fixes applied.`; `bun run typecheck` → 0. Full `bun test` and the simulator gate were NOT re-run (the e2e runs 6/7 are taken from Execution).

Mutation non-vacuity (each reverted, tree clean afterwards): `link(up)` without `runOutbox` → `session-screen-compose` 1 fail; Send later back to `await basis()` → `compose-controller` "never waits" fails; `nothingRunning` back to `groups.length === 0` → `activity.test` 1 fail. Holds.

§7 checks: the side `serve` (flow 17) starts only after the hook has confirmed the main `serve` is down, so there is never a second daemon on the store (one-daemon-per-store holds); it runs `--no-relay`. The product changes stay in pure modules (`newSessionFromHub`, `offlineBasis`, `nothingRunning`, `rowAccessibility`). No protocol or persistence change. `offlineBasis` with no read yet gives `{0,null}` → "changed" → the person is asked, never lost. A `primeBasis` read still pending when the link drops resolves after the reconnect and only replaces `lastBasis`; an item already written keeps its own copy.

**MEDIUM: `apps/mobile/src/ui/Row.tsx:151`, `control: trailing !== undefined`.** The pure rule says a row ungroups only for a trailing CONTROL. The component instead treats ANY defined `trailing` as one, including `null` and plain text. Where it goes wrong:
- (a) `CommandsSheet.tsx:280`: `edgeFor` returns `null` for every `ready` row, so every ready Commands row stops being one button. The Pressable becomes `accessible={false}` and only the label column is a button.
- (b) `CommandsSheet.tsx:162` (dimmed): the reason `<Text>` and `ToolsSheet.tsx:79` (`null` when a band has no switch) ungroup the same way.
- (c) `SessionInfoSheet.tsx:226`: a read-only row's `values` (Text) ungroups too, so VoiceOver reads the label and the value as separate elements. That breaks the "read-only row: label + value read together" contract in `rowAccessibility`'s own doc.

No test covers this mapping. `row-value.test.ts` tests the pure function only, so the bug sits in exactly the untested component logic §7 warns about. Fix: let the caller say what the trailing element is (e.g. a `trailingControl` flag, or `trailingKind: "control" | "value"`) and pass that to `rowAccessibility`. Pin it with a test on a `null`/value trailing.

Behaviour of the executor: the triage was evidence-led and honest about the 7 quarantines and the flaky `serve-mcp` T12. The mutation claims I re-checked hold.
