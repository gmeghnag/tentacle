# fix/engine-runtime-stderr-flake — "dropped link" tests race the redial

> **Status:** execution
> **Branch:** `fix/engine-runtime-stderr-flake`
> **Size:** S · **Blast:** contained · **Suited:** weaker model + standard Review (test-only)

## Context

*— claude-sonnet-5-5, 2026-11-06*

`packages/cli/test/engine-runtime.test.ts` › "startPodRuntime > daemon stderr on
exit" failed once in the full `bun test packages` (6.5 ms) on the run-rm-flag
build, then passed alone. A timing flake under load.

**Repro** (2026-11-06, on main c42cb43):

```
bun test --rerun-each 50 packages/cli/test/engine-runtime.test.ts -t "daemon stderr on exit"
```

Failed 1 run of 50 (run #32): test "a link that dropped (the daemon died): ONE
line with the log path, no dump" (the `run` twin of the `attach` one in the
report), assertion at the `logs.filter(… "unexpectedly")` line:
expected `["[pod] box: daemon stopped unexpectedly · log: …/daemon.log\n"]`,
received `[]`. A second run (×100, with the statuses printed on failure) failed
again, 1/100, with:

```
STATUSES [{"state":"reconnecting","attempt":1,"nextAtMs":…},{"state":"up"},{"state":"stopped","reason":"closed"}]
```

**Root cause:** the test drops the link then waits for "any status that is not
`up`" (`until(() => statuses.some(s => s.state !== "up"))`). The link machine
immediately redials (jittered backoff, `link-machine.ts` `scheduled`), and
`DroppingCluster` lets the redial succeed. Under load the redial returns `up`
before the test resumes and calls `dispose()`. `createFaultWatch`
(`engine-runtime.ts:137`) deliberately treats a reconnect that came back `up` as
NOT a fault (round 5), so no "stopped unexpectedly" line is printed — correct
product behaviour; the test simulated a dead daemon but did not make it stay
dead. Test-only; no product change.

## Implementation

*— claude-sonnet-5-5, 2026-11-06*

### Load-bearing assumption

A daemon that died is a redial that FAILS for good. `getPodResult` rejecting
with a 404 makes the link go `stopped` (non-"closed" reason), which is what
`createFaultWatch` latches as `ended`. Already used by the existing
"reconnect-gone" test (`engine-runtime.test.ts` ~2989).

### Design / Files

`packages/cli/test/engine-runtime.test.ts`, the two tests "a link that dropped
(the daemon died)…" and "attach: a dropped link…": before `kube.drop()` set
`kube.getPodResult = () => Promise.reject(new KubeApiError(404, …))`, and wait
for `statuses.at(-1)?.state === "stopped"` (an event, deterministic end state)
instead of "not up".

### Failure modes

Waiting on the terminal state removes the race entirely: the redial can no
longer succeed, and the assertion reads state that has settled.

### Tests

The fix is to the tests themselves. Red: 1/50 and 1/100 failures above. Green:
see Execution. Non-vacuity: the tests still fail if `quitReport` is never
printed ("Mutation: never report" comment kept).

## Execution

*— claude-sonnet-5-5, 2026-11-06*

Edited the two tests as above. Results with the same commands:

- `bun test --rerun-each 100 packages/cli/test/engine-runtime.test.ts -t "daemon stderr on exit"` → 1700 pass, 0 fail (was 1 fail per 50–100).
- Gate: see the final report of the executor (tsc, biome, `bun test packages/cli`).

No drift from the plan; no product code touched; no CHANGELOG (test-only).
