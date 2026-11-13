# fix/reattach-replay-flake — the replay test raced a 3 s budget against the fake's timer sleeps

> **Status:** review
> **Branch:** `fix/reattach-replay-flake`
> **Size:** S · **Blast:** contained · **Suited:** DeepSeek (weaker model, standard Review — test-only)
> **Changelog:** none (test-only, AGENTS §10)

## Context

*— claude-opus-5-5, 2026-11-13*

`packages/client/test/reattach.test.ts` › *"attach mid-turn behind a long reply
(docs/fix/detach-live.md, round 9 / KO 3) > a replay past the client's buffer
bound converges: live, every delta once, in order, no give-up"* fails **only in
the full `bun test`** and passes alone (3/3). It reverted two good merges today
— `feat/attachments-tui` (03:18) and `feat/device-pairing` (17:32):

```
(fail) … a replay past the client's buffer bound converges … [3003.67ms]
error: until: timed out after 3000 ms waiting for () => model.waiting
    at async <anonymous> (packages/client/test/reattach.test.ts:773:18)
```

Note the time is **3003 ms, not bun's default 3000 ms per-test timeout** — the
test declares `}, 30_000)`, so bun never killed it. The budget that expired is
`until()`'s own default (`test/support/fakes.ts:107`), i.e. the test's first wait.

**Root cause (one sentence):** `GatedModel` advances one scripted event per
**`setTimeout(0)`**, and Bun clamps a timer to ~1 ms, so the test's 2049 pre-gate
deltas cost ~2.5 s of pure fake wall clock against a 3 s `until` budget — a
margin thin enough that any CPU contention tips it over.

Measured attribution (2026-11-13, this worktree):

```
2049 events via setTimeout(0): 2577 ms   (until budget: 3000 ms)
2049 events via setImmediate:     1 ms
REPRO time-to-gate: 2559 ms  (instrumented run of the test itself)
=> of the test's 2610 ms, 2559 is the fake's pre-gate stream; product work ~50 ms
```

The wait budget is not work: it is a fake's sleep granularity times 2049.

### Repro

**Command** (scratch: `.tentacle/tmp/reattach-replay-flake/`, gitignored):

```sh
# stress.sh <label> <busy-loops> <runs> — oversubscribe the CPUs, run the test N times
cat > .tentacle/tmp/reattach-replay-flake/stress.sh <<'SH'
#!/bin/sh
label=$1; L=${2:-56}; R=${3:-10}
WT=/Users/gmeghnag/tentacle/.tentacle/worktrees/reattach-replay-flake
cd "$WT" || exit 1
i=0
while [ $i -lt $L ]; do ( while :; do :; done ) & i=$((i+1)); done
sleep 3
r=0; fails=0
echo "== $label: $L busy loops on $(sysctl -n hw.ncpu) cpus, $R runs =="
while [ $r -lt $R ]; do
  r=$((r+1))
  out=$(bun test packages/client/test/reattach.test.ts -t "replay past the client's buffer bound" 2>&1)
  ms=$(printf '%s' "$out" | sed -n 's/.*Ran 1 test across 1 file\. \[\(.*\)\]/\1/p')
  if printf '%s' "$out" | grep -qE '^ 1 pass'; then st=PASS; else st=FAIL; fails=$((fails+1)); fi
  msg=$(printf '%s' "$out" | sed -n 's/^error: \(.*\)/\1/p' | head -1)
  echo "run $r: $st $ms ${msg}"
done
echo "== $label: $fails/$R failed =="
kill $(jobs -p) 2>/dev/null; wait 2>/dev/null
SH
sh .tentacle/tmp/reattach-replay-flake/stress.sh BEFORE 56 10     # 14-cpu box
```

**Output — before (original `fakes.ts` + test, on this branch's base):**

```
== BEFORE: 56 busy loops on 14 cpus, 10 runs ==
run 1: FAIL 3.06s until: timed out after 3000 ms waiting for () => model.waiting
run 2: FAIL 3.05s until: timed out after 3000 ms waiting for () => model.waiting
run 3: FAIL 3.05s until: timed out after 3000 ms waiting for () => model.waiting
run 4: FAIL 3.06s until: timed out after 3000 ms waiting for () => model.waiting
run 5: FAIL 3.06s until: timed out after 3000 ms waiting for () => model.waiting
run 6: FAIL 3.06s until: timed out after 3000 ms waiting for () => model.waiting
run 7: PASS 3.08s
run 8: FAIL 3.06s until: timed out after 3000 ms waiting for () => model.waiting
run 9: FAIL 3.06s until: timed out after 3000 ms waiting for () => model.waiting
run 10: FAIL 3.06s until: timed out after 3000 ms waiting for () => model.waiting
== BEFORE: 9/10 failed ==
```

Same assertion, same message, same ~3.06 s as the two gate logs — the flake is
reproduced deterministically.

**Timings, before → after** (identical load, 56 loops / 14 cpus):

| | before | after |
|---|---|---|
| single run, no load | 2.62 s | 63–73 ms |
| oversubscribed, worst of 10 | 3.08 s (**9/10 failed**) | 242 ms (**0/10 failed**) |

## Implementation

*— claude-opus-5-5, 2026-11-13*

### Load-bearing assumption

`GatedModel`'s per-event yield is what the replay test waits on, and no product
property depends on it being a *real timer*. Verified: the only yield is
`fakes.ts:58` (`await new Promise((r) => setTimeout(r, 0))`), and the test's
first wait is `until(() => model.waiting)` (`reattach.test.ts:773`), which is
only satisfied once the 2049 pre-gate events have streamed. The product code
(`remote-client.ts`, `session-reducer.ts`, `ring.ts`) never sees the fake's
timer — it receives `StreamEvent`s.

### Preconditions

- The replay must still exceed the bound it is named for. The client's replay
  buffer is `MAX_BUFFERED_BYTES = 64 * 1024 * 1024` (`session-reducer.ts:39`,
  raised from a 2048-**update** count by `5457ff8`); the daemon's ring is
  `DEFAULT_RING_BYTES = 4 MiB` (`daemon/src/hosted-session.ts:233`), pinned past
  the snapshot cut (`daemon/src/ring.ts:1-13`). The scripted 2248 deltas exceed
  the *old* 2048-update bound, which is the regression the test guards.
- `setImmediate` is still a **macrotask** yield, so `createChannelPair`'s
  `queueMicrotask` frames (`transport/src/channel.ts:40`) still drain between
  steps, and real timers are not starved — measured: inside a 200 000-iteration
  `setImmediate` loop a 5 ms timer fired at 5.0 ms.
- The default stays a real timer: twelve other tests in `client`/`cli` drive a
  reconnect *while* the fake streams and depend on that interleaving.

### Design

Two smallest-diff pieces:

1. `GatedModel` takes an optional yield mode, default `"timer"` —
   `docs/fix/engine-runtime-stderr-flake.md`'s principle, applied to a fake:
   the stream must advance on something the test *observes*, not on wall clock.
2. The replay test opts into `"immediate"`, because its 2049 events all stream
   **before** any attach, so they race nothing; the post-gate events (`"end"`)
   still go through the same yield, now cheap.

Not done: raising `until`'s budget or the test timeout. The work is not
inherently 3 s — it is 2.5 s of timer granularity in a mock, and the property
is provable in ~60 ms.

### Files

- `packages/client/test/support/fakes.ts` — `GatedModel` yield mode (default
  unchanged).
- `packages/client/test/reattach.test.ts` — the replay test passes `"immediate"`.

### Failure modes

- **A test that needs the timer interleaving** (T-B5, send-now across a drop):
  covered by keeping `"timer"` the default. Confirmed by running the whole
  `client`+`cli` suites — see Execution.
- **A cheaper yield hiding a real ordering bug**: the property asserted is
  unchanged (every delta once, in order, no give-up), and the mutation below
  shows the test still fails when convergence breaks.
- **Non-vacuity**: bound mutation → red (below).

### Tests

The test itself is the artefact; no new test file. Red-before-green is by
**mutation** (AGENTS §9): shrink the client's replay bound below the replay and
the test must fail.

## Execution

*— claude-opus-5-5, 2026-11-13*

1. **Reproduced** the gate failure with CPU oversubscription: 9/10 fail at
   3.06 s, identical assertion (`stress.sh BEFORE 56 10`).
2. **Attributed** it: instrumented `reattach.test.ts:773` →
   `time-to-gate 2559 ms` of 2610 ms; a standalone benchmark showed
   `setTimeout(0)` = 1.25 ms/yield vs `setImmediate` = 0.5 µs/yield.
3. **First attempt (rejected):** changed the fake's yield globally to
   `setImmediate`. It made the replay test 63 ms — and **broke T-B5**
   (`send-now across a drop`, `reattach.test.ts:1401`): the `send_now` re-send
   then left on `frames[0]` before the drop, so `frames[1]` never carried it.
   That is a real drift in *which interleaving* the test exercises, not a stale
   assertion — so a global change was too blunt. Reverted.
4. **Final:** opt-in yield mode, default `"timer"`; only the replay test opts
   into `"immediate"`. T-B5's timing untouched.
5. **Non-vacuity (mutation):** `MAX_BUFFERED_BYTES` 64 MiB → 1024 →
   `until: timed out after 3000 ms waiting for () => texts.at(-1) === "end"`,
   0 pass / 1 fail. Restored → pass.
6. **Gate:** see Review. `bunx tsc --noEmit` exit 0 · `bun run lint` clean (971 files) · `bun test`
   7690 pass / 3 opt-in skips / 0 fail across 549 files (298.83 s), including the
   replay test.

Drift from Implementation: none (the rejected global change is recorded above
because it is why the design is opt-in rather than global).

## Review

*— claude-opus-5-5, 2026-11-13*

Self-review (test-only, `contained`, per AGENTS §10 a standard in-context Review
is allowed at this blast radius; the fresh-context option is noted below).

**Gate:**

```
bunx tsc --noEmit   → exit 0
bun run lint        → Checked 971 files in 309ms. No fixes applied.  (0 errors, 0 warnings — matches the clean baseline)
bun test            → 7690 pass, 3 skip (the opt-in ones), 0 fail · 549 files, 298.83s
```

**What holds:**

- The flake's cause is proven by measurement, not inference, and the repro
  reproduces the gate's *exact* assertion and duration.
- The fix is on the cause (fake's sleep granularity), not on the symptom
  (budget/timeout untouched: still `until` 3000 ms, test `30_000`).
- The proven property is unchanged and still non-vacuous (mutation red).
- 0/10 failures under the load that used to fail 9/10; the full `client`+`cli`
  suites (2601 tests) pass, so no neighbouring test relied on the old timing.

**What does not hold / limits:**

- Load was simulated by CPU oversubscription, not by the real 549-file suite (298.83 s).
  They agree on the observable (same assertion, ~3.06 s), but the stress is an
  approximation of the gate's contention.
- Not verified: repeated full-suite runs (each is ~280 s). The single-file
  stress plus two full `client`+`cli` runs is the evidence offered.
- The `"immediate"` mode is a knob in a shared fake; a future long-script test
  could reach for it where the timer race *is* the property. The doc comment
  says when it is legitimate (a stream that races nothing).
- Fresh-context Review was not run (test-only, contained). If the orchestrator
  wants one, the red-team target is: *does any test depend on the fake's
  per-event wall clock?* — answered by the 2601-test `client`+`cli` run.

**How the implementing model behaved:** reproduced before diagnosing (§1) and
rejected its own first fix on evidence rather than shipping it, which is the
behaviour the flake class needs.

## Review

*— claude-opus-5-5, 2026-11-13* (fresh-context adversarial review, `git diff main...HEAD`)

**Verdict: PASS** — no HIGH/MEDIUM findings in the code.

- **Scope:** test-only (`fakes.ts`, `reattach.test.ts`); no §7 invariant is
  touched (no product, protocol, persistence or terminal path).
- **Claim "races nothing" holds:** all 2248 pre-gate deltas stream before
  `until(() => model.waiting)` returns, i.e. before client `b` connects; only
  `"end"`/`done` stream after `model.open()`, and the asserted property
  (every delta once, in order, ≤1 reset) is unchanged.
- **Default preserved:** `"timer"` stays the default; the replay test is the
  only `"immediate"` caller, so the interleaving that T-B5 and the other
  reconnect-race tests rely on is unchanged.
- **Non-vacuity, re-run here:** `MAX_BUFFERED_BYTES` 64 MiB → 1024 ⇒
  `until: timed out … texts.at(-1) === "end"`, 0 pass / 1 fail; reverted (tree clean).
- **Gate (here):** `reattach.test.ts` 54/54 pass (replay test 76 ms);
  `packages/client`+`packages/cli` 2601 pass / 0 fail; `bun run lint` clean
  (971 files); `bun run typecheck` exit 0. Full `bun test` not re-run (the
  Execution reports 7690 pass / 3 opt-in skips).
- **Process note (low):** the doc header says `Branch: fix/reattach-replay-flake`
  but the branch is `feat/reattach-replay-flake`; §10 wants `<type>/<slug>` to
  match `docs/fix/`. Rename the branch (or fix the header) before merge.
