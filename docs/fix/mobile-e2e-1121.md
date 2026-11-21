# fix/mobile-e2e-1121 — four red mobile e2e flows on main (2026-11-21)

> **Status:** execution (review pending: the orchestrator's full gate)
> **Branch:** `fix/mobile-e2e-1121`
> **Size:** S · **Blast:** contained · **Suited:** Opus exec + standard Review (the orchestrator's gate run)
> **Changelog:** `changelog.d/mobile-e2e-1121.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-21*

The full gate (`scripts/e2e-gate.sh`, iPhone 17 Pro iOS 26 `0FA4B51F…`, run
`1795279573638`, main a1ef3c9c + docs) failed 4 counted flows. Each was
classified from its screenshot, hierarchy and `maestro.log`, then **re-run once
alone** on an unchanged build (run `1795285368387`) to tell real reds from flakes:

| flow | full gate | alone, unchanged | verdict |
|---|---|---|---|
| 05-daemon-down | FAIL | FAIL | flow drift (an intended UI change) |
| 08c-permission-reply | FAIL | FAIL | app bug (old, not from today's merges) |
| 26-drawer | FAIL | PASS | cascade of 08c |
| 22-relay-only | FAIL | PASS | flow drift, depends on timing (prompt-current-date) |

**05-daemon-down — `Assertion is false: id: sessions-list is visible`.** The
failure screenshot is the Computers screen: the project row reads `Stopped · run
\`tentacle serve\``, right after the flow tapped `computer-<id>` while serve was
down. Tapping a stopped/unreachable row re-probes and does **not** open. That is
intended since `feat/mobile-projects-app` (0b65e100,
`docs/feat/mobile-projects.md:992` "retries it (stopped / unreachable) or opens the
sheet", mockup A3). `fix/mobile-project-first-tap` (9dc0ec96) kept this
(`projectTap` → `reprobe`; the wait opens only when the probe answers). The flow
still expected the old "open the offline list" tap. **Flow drift.**

**08c-permission-reply — `Assertion is false: id: turn-idle is visible`.** In the
failure screenshot the permission sheet is still up, **with the keyboard on
screen**. The hierarchy has `perm-reply-send` at `[20,648][382,698]` and the
keyboard at `[0,539][402,874]`. Maestro's `hideKeyboard` (4 s) did not dismiss the
keyboard of the sheet's **multiline** field, so the tap at (201,673) landed on the
keyboard's `g` key (the field reads "G") and the reply was never sent. The same
red was recorded on 2026-11-19 (`docs/fix/mobile-qa-1119.md:310`, "the keyboard
does not hide over the sheet", wrongly put down to the simulator). It was not
caused by today's merges: `PermissionSheet.tsx` last changed in e1f7941d
(theme-beta, the Text seam only). The root cause is the app: the sheet is a
`pageSheet` Modal, the keyboard does not resize it, and nothing scrolls the
button above the keyboard. On a phone, a person who types a reply cannot see
Send. **App bug.**

**26-drawer — `Element not found: session-rename-save`.** In the failure
hierarchy the rename sheet is gone, and the drawer shows `Permission th…
Running · 1 attached`: that is 08c's turn, left suspended on its ask. It passes
alone (run `1795285368387`). `mobile-qa-1119.md:317` recorded the same cascade.
**Cascade of 08c**, with no change of its own.

**22-relay-only — `the mock model was never asked the relay-only prompt`.** The
history step before it passed (the daemon has user `relay only` and the mock's
answer), so the turn did go through the relay. What failed is the prompt match
`p === "relay only" || p.startsWith("relay only\n")`. Alpha's serve log
(`config/daemon/…/86fedb7b….jsonl`) shows its last date stamp from the seeding at
**17:46:13**, and `relay only` sent at **18:56:27** carrying `dateStamp`. That is
more than `DATE_STAMP_MAX_AGE_MS` (30 min) later, so
`fix/prompt-current-date` (392b3b7c) **prefixes** `[Sat 2026-11-21 18:56 CET]\n`
to the model's copy. Run alone, 22 sends well within 30 min of the seeding, so
there is no stamp and it passes. The stamp is intended. **Flow drift**, and it
only shows when the suite runs long.

## Implementation

*— claude-opus-5-5, 2026-11-21*

- **08c (app):** `PermissionSheet.tsx`: the sheet's `ScrollView` gets
  `automaticallyAdjustKeyboardInsets` and a `keyboardDidShow` listener that
  `scrollToEnd`s it. Send reply is the sheet's last control, so it lands just
  above the keyboard. This is presentation only (no decision moves, AGENTS §7).
  The regression test is the source pin
  `apps/mobile/test/permission-sheet-keyboard.test.ts`, the
  `project-tap-wiring.test.ts` pattern, since RN components are not renderable
  from Bun.
- **22 (flow):** `22-relay-history.js` matches the prompt on a **line**, like
  `mock-model.ts` `promptLine`, so the stamp's prefix line and the context line's
  suffix both pass. The failure message now lists what was asked.
- **05 (flow):** the recovery is proved on the Sessions screen that
  `drawer-search` resets to while still offline (refresh → `sessions-stale`
  visible; start serve; refresh → Alpha back, notice gone), so finding 1's
  "the notice is ON first" stays non-vacuous. Then, back on Computers, the tap on
  the project row now waits for the row to answer and opens it (`extendedWaitUntil
  sessions-list`). The `05-computers-offline` shot became `05-computers-back`.
  The stopped row is already shot by flow 37 (`37-a3-stopped`).
- **26:** no change (cascade).

## Execution

*— claude-opus-5-5, 2026-11-21*

Files: `apps/mobile/src/screens/PermissionSheet.tsx`,
`apps/mobile/test/permission-sheet-keyboard.test.ts` (new),
`apps/mobile/e2e/flows/22-relay-history.js`,
`apps/mobile/e2e/flows/05-daemon-down.yaml`,
`changelog.d/mobile-e2e-1121.fixed.md`.

- Red → green: `bun test apps/mobile/test/permission-sheet-keyboard.test.ts` on
  the pre-fix `PermissionSheet.tsx` → `1 pass, 2 fail` (the inset, the
  scroll-to-end). With the fix → `3 pass`. `permission-sheet.test.ts` still
  28/28.
- `tsc -p apps/mobile` clean. `biome check` on the touched files clean.
- Flows (`scripts/e2e-gate.sh 0FA4B51F… --only
  05-daemon-down,08c-permission-reply,26-drawer,22-relay-only`):
  - run `1795286260264` (first fixed build): 08c PASS, 26 PASS, 22 PASS. 05 FAIL
    later than before: the recovery steps passed, but right after the
    `sessions-back` tap (Maestro: "something changed") the screen was still
    Sessions, and the immediate `assertVisible computers-list` failed.
  - **Drift from Implementation:** 05 now waits for Computers
    (`extendedWaitUntil`, 10 s) and adds a guarded second `sessions-back` tap
    (`runFlow when notVisible computers-list`).
  - run `1795286962238`: **GATE PASS — 4 passed, 0 failed (of 4; 280 s).** In
    05 the guarded tap was SKIPPED: the first tap reached Computers, so the wait
    was what mattered in that run. Why the earlier tap did not navigate at once
    is unverified (most likely a keyboard dismissal on the search field). To
    check it: look for the `when` tap firing in future full-gate logs.

### Main-merge fix

*— Claude via Claude Code (the harness does not expose the exact model id), 2026-11-21*

After the `main` merge, `bun test` went red on two of the flow meta-tests in
`apps/mobile/test/e2e-flows.test.ts`: *"flow 05: the daemon-down recovery is
actually asserted > its last assertion is not the always-visible container"* and
*"every flow asserts something narrower than its container > no flow ENDS on the
container it starts on"*. Both read the same fact: the Computers wait added above
(`extendedWaitUntil sessions-list`, 20 s) became the flow's LAST assertion, and
`sessions-list` is the ScrollView — on screen in every state, which is exactly
review round 1 finding 2 (the guard at the top of that test file). The 10 s wait
and the guarded second `sessions-back` tap are untouched; what changed is the
flow's tail:

- kept the `extendedWaitUntil sessions-list` after the `computer-<id>` tap (it is
  what gives a re-probed row time to answer and open);
- then `scrollUntilVisible session-${ALPHA_ID}` (DOWN, 20 s) + `assertVisible`
  on the same id. A seeded row of THIS project can only be drawn from the list
  the restarted `serve` served, so the flow now ends on daemon content, not on
  the container. Scrolled to first because in the full suite earlier flows'
  sessions sit above it (`docs/fix/mobile-e2e-reds.md`).

Why the scroll rather than a bare assert: the row is the thing the recovery
proves, but it can be below the fold in a full-gate run — the same reason the
flow's first Alpha step scrolls. The recovery itself was already asserted
earlier (row back + `sessions-stale` gone, both after `05-start-serve.js`), so
this tail is a non-vacuous closer, not the only proof.

- Red → green: `bun test apps/mobile/test/e2e-flows.test.ts` before → `36 pass,
  2 fail` (the two above); after → `38 pass, 0 fail`. Then the full
  `bun test` → `16391 pass, 5 skip, 0 fail` (the 5 skips are the opt-in
  k8s/docker/slow/root ones, unchanged).
- **Not verified:** a device run of 05 with the new tail (`scripts/e2e-gate.sh
  … --only 05-daemon-down`). The tail's risk is the scroll not finding the row in
  20 s while the list is re-drawn by the pull-to-refresh; the earlier `session-`
  wait after `05-start-serve.js` already proves that row is on the list page it
  lands on, so the risk is small — but it is unrun.

**Not done / debt:** `07-history.js` and `23-history.js` use the same
`startsWith` prompt match. They pass today because they run within 30 min of
their session's last stamp, but a slower suite would turn them red the way 22
went. They were not changed here because this task does not re-run them.
Follow-up: move every flow's prompt match onto one line-based helper.
