# fix/mobile-e2e-reds — Triage the mobile e2e gate's reds (+ fix/mobile-hub-new-session)

> **Status:** execution
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

EXIT_RUNS_PLACEHOLDER

### Gate

GATE_PLACEHOLDER

## Review

*— (pending: fresh-context review)*
