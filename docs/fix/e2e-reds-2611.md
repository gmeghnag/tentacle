# fix/e2e-reds-2611 — Six e2e reds on main 5c739eed

> **Status:** execution
> **Branch:** `fix/e2e-reds-2611`
> **Size:** S · **Blast:** contained (e2e flows + one wiring line in `App.tsx`) · **Suited:** standard review
> **Changelog:** none (internal; the offline banner now appears, but it is the behaviour landing-v2 specified)

## Context

*— claude-sonnet-5-5, 2026-11-26*

The full gate on main 5c739eed failed six flows; a single rerun was still red. Classification, each re-run on the new branch (parallel gate, `--only`, both simulators):

| flow | class | evidence |
|---|---|---|
| 33-hub | FLAKE | red in the gate on sim 0FA4B51F (`hub-notice` not visible); green on 0B43D716 in the re-run, and green in the single re-run before. No code touched. |
| 30-artifact-escape | FLAKE | red in the gate (`artifact-html-viewer` not visible); green in the re-run and in the earlier single re-run. No code touched. |
| 37-projects | FLAKE | red in the gate and the single re-run on 0FA4B51F (`computer-state-…-(new\|idle)`), green on 0B43D716 here. No code touched. |
| 41-transcript-type-shots | STALE FLOW (intended UI) | `scrollUntilVisible text "Quitting now only.*"` fails; the hierarchy shows the whole assistant message is now ONE element `row-r16-copy` whose accessibility text is the concatenated message (feat/mobile-copy-text, `docs/feat/mobile-copy-text.md`: the row is a copy target). The regex must match the whole label: now `".*Quitting now only.*"`. |
| 38-running-row | FLOW RACE (not app) | `perm-sheet` appears at the instant the wait returns and `perm-allow_once` is tapped at once; the tap is inside the sheet's age guard (`permission-sheet.ts` `ARM_MS = 400`) and is dropped; failure screenshot shows the second sheet still up 30 s later with the button enabled. Fix: `waitForAnimationToEnd` before the tap in `_runrow-turn.yaml`. Failed 3/3 before, passes after. |
| 46b-workflow-landing-shots | REAL APP BUG (landing-v2) | After `16-stop-serve.js` the landing never shows `workflow-landing-offline`: `offline` comes from `runs.state.offline`, which the runs controller sets only when a READ fails, and reads are triggered only by `session/workflows` notices and focus. A dropped link triggers neither, so the banner never appears (screenshot: list online, no banner after the 60 s wait). The flow was never run on a simulator before the merge (doc `mobile-workflows-landing-v2.md`, "flows 46 / 46b were never run"). Fix: `useWorkflowRuns` also reads on `client.onLinkStatus`. |

## Implementation

*— claude-sonnet-5-5, 2026-11-26*

- Files: `apps/mobile/e2e/flows/41-transcript-type-shots.yaml`, `apps/mobile/e2e/flows/_runrow-turn.yaml`, `apps/mobile/App.tsx` (`useWorkflowRuns`: `onNotice` also subscribes `onLinkStatus`), `apps/mobile/test/workflow-start-wiring.test.ts`.
- Test: a source-wiring test (the file's pattern; the hook is React wiring, the controller's rules are untouched). Red on the buggy `App.tsx` (stashed), green with the fix.
- Failure mode: link flaps cause extra reads, debounced by the controller (`RUNS_DEBOUNCE_MS`); a read while down fails to `offline`, a read once up clears it.

## Execution

*— claude-sonnet-5-5, 2026-11-26*

As planned, no drift. Final proof: all six flows green on BOTH simulators (0B43D716: GATE PASS 6/6, 787 s; 0FA4B51F: GATE PASS 6/6, 813 s), typecheck + lint clean, `bun test apps/mobile/test` 5715 pass 0 fail.

## Review

*— pending*
