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

*— claude-opus-5-5, 2026-11-26* (fresh context; different model from the executor, Sonnet)

**Verdict: APPROVE-WITH-NITS** — no HIGH/MEDIUM findings.

Gate (narrow, as asked): `bun test apps/mobile/test` 5715 pass / 0 fail; `workflow-start-wiring.test.ts` 24/0; `bun run lint` clean (2635 files); `bun run typecheck` clean (root + mobile + relay). e2e flows were not re-run on a simulator by the reviewer (the executor reports 6/6 on both sims).

Premises:
| claim | verdict |
|---|---|
| `offline` is set only when a read fails (`workflow-runs-controller.ts` `failed`) | TRUE |
| reads come only from focus / pull / `onNotice` (debounced `RUNS_DEBOUNCE_MS`) | TRUE |
| a read while down fails fast (`remote-client.ts:1656` rejects when `!up && channelFactory`) → `offline` | TRUE |
| link "up" is emitted after `up = true` (`remote-client.ts:3690-3693`), so the read it triggers lands and clears `offline` | TRUE |
| `ARM_MS = 400` (`permission-sheet.ts:52`) | TRUE |

Mutation: replaced the `onLinkStatus` subscription with a no-op in `App.tsx` → the new test FAILS (23/1); restored from a scratch copy, `git status` clean.

Attacks tried:
1. **Read loop while down** — each failed redial emits a status (`schedule` → `emitStatus`, `remote-client.ts:3649`), so each backoff step costs one debounced `workflow/list` attempt. It is bounded by the backoff, and each attempt fails locally with no wire traffic. Not a loop. Holds.
2. **Leak / landing after unmount** — the composed unsubscribe calls both `off*`, the controller's `dispose` → `stopListening` calls it, and `read()` returns early once disposed. Holds. (Nit: the wiring test is a string match, so dropping `offLink()` from the cleanup would not fail it. Acceptable for this file's pattern.)
3. **§7 invariants** — no protocol, persistence, broker or RPC-peer change. The hook still only wires and `onLinkStatus` is an existing public subscription. Nothing violated.
4. **Missed sites, same race** — other flows still tap `perm-allow_once` right after `perm-sheet` is visible (27, 29, 36, 41-file-view, 41-transcript, 46). They are latent flakes of the same class, outside this task's six reds. Worth a TODO, not a blocker.

Nits: the controller's header and `WorkflowRunsDeps.onNotice` doc still say `onNotice` is only `onSessionWorkflows` ("does not retry in a loop … next notice reads again"). It is now link status too, so the comment should say so. `waitForAnimationToEnd` waits for a static screen, not 400 ms: it is a probabilistic guard, though it was empirically green.

Executor behaviour: classified each red with evidence, kept the scope tight, and showed the test red-then-green. Nothing in the doc was overstated.
