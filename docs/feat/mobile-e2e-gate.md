# feat/mobile-e2e-gate — a deterministic, AI-free mobile e2e gate

> **Status:** execution
> **Branch:** `feat/mobile-e2e-gate`
> **Type:** feat · **Size:** M · **Blast:** contained (tests/tooling) · **Suited:** Opus
> **Changelog:** none (dev-only tooling)

## Context

*— claude-opus-5-5, 2026-11-18*

Owner 18/11: *"avere i test automatici, senza AI, in place è sempre stato il nostro
forte: facciamolo anche su mobile"*. The mobile pure modules are in `bun test`, but the
Maestro suite (`apps/mobile/e2e/flows`, driven by `bun run e2e:mobile`) only ran when an
AI agent drove it by hand: it needed a hand-picked simulator, it stopped at the first
build, it printed one `✓/✗` line per flow and the exit code was Maestro's worst one, with
no notion of a flow that is known-broken. So UI wiring regressions reached the phone — the
reported one: "New session" from the hub no longer opens a session; and flow `33-hub` is
red because of the flow itself.

The decision this serves: the iOS build that publishes `tentacle.so/i/<token>/`
(`.tentacle/tmp/orchestration/run-build-ios-now.sh`) can call ONE command and refuse to
publish on red, and a nightly run can do the same unattended.

**Repro (the capability is missing), 2026-11-18, on `main` @ 753d7fa2:**
`bun run e2e:mobile --udid EF264127-…` with only iOS 26 installed → preflight exit 2
(*iOS 18 runtime missing*): a UDID did not imply its major. With `--ios 26 --udid …` the
run works, but its end is `FAIL — logs in <dir>` with Maestro's exit code, no table, no
per-flow time, no timeout (a hung XCTest driver stalls the run forever), no retry policy
and no way to mark a flow known-broken.

## Implementation

*— claude-opus-5-5, 2026-11-18*

### Load-bearing assumption

Each flow is already state-isolated, so running them one after another unattended is
deterministic: every flow pairs first through `_pair.yaml` with `launchApp: clearState:
true` + `clearKeychain` (`apps/mobile/e2e/flows/_pair.yaml:21-23`), the harness closes any
pairing window between flows (`run.ts` `pairing.stop()` in the flow loop), and every flow
that leaves daemon-side state gets a session of its own created just before it runs
(`COMPOSE_SESSION_VARS` + `spawnFlow`). The gate adds a `simctl terminate` before each
attempt; it does not invent a new isolation scheme.

### Preconditions

- The harness already owns the world: mock model in-process (`mock-model.ts`), a real
  `serve` from source on `freePort()` (ephemeral, `127.0.0.1`, private config dir), local
  relay + fake APNs, hooks server (`run.ts` `main`). Never port 4000 (now also guarded).
- Maestro reads a flow's header config (before `---`), where `tags:` is native; a single
  `maestro test <file>` ignores tags, so gate tags cannot change how Maestro runs a flow.
- `apps/mobile/test/e2e-flows.test.ts` pins flow hygiene (every flow pairs, names
  `${output.computerId}`, asserts more than its container); new flows must satisfy it.

### Design

- **`apps/mobile/e2e/gate.ts`** (pure, React-free, unit-tested): the gate's decisions.
  - Tags live in the flow's own header: `tags: [flaky | known-bug | quarantine]`, each
    with a `# <tag>: <reason>` line. A tag without a reason (or a reason without a tag,
    or `quarantine` plus another tag) is refused before anything runs (exit 2).
  - `flaky` → ONE retry (`shouldRetry`), listed in the summary; nothing else retries.
  - `known-bug` → runs, not counted; listed; if it passes the summary says *drop the tag*.
  - `quarantine` → not run; listed with its reason; must have a `TODO.md` line (test).
  - `verdictOf` → exit 0 iff no counted flow is red (fail or timeout).
  - `summaryText` → the one table (flow · result · seconds · tries) + counts + the lists.
  - `majorOfDevice` → a UDID names its iOS major (from `simctl list -j devices`).
- **`run.ts`**: `--udid` (or `E2E_SIM_UDID`) without `--ios` runs that simulator only,
  never falling back to another device; it boots it (`simctl boot` + `bootstatus -b`),
  uninstalls the app then builds+installs once per run (or installs `--app <path.app>`),
  runs each flow with a per-attempt timeout (`--flow-timeout` / `E2E_FLOW_TIMEOUT_S`,
  default 600 s, SIGKILL + `timeout.txt`), writes `summary.txt` + `summary.json` in the
  run dir and returns the verdict's exit code. Each attempt keeps its own output dir
  (`ios<major>/<flow>[.retry]/`: Maestro's failure screenshots, `maestro.log`, JUnit).
- **Hub coverage** — `34-hub-<item>.yaml`, one per fan item and More item, each on a
  fresh session (`HUBITEM_ID`), each asserting the surface the item names: Attach → the
  chooser; Activity (two background children running) → `activity-sheet` with the child;
  Artifacts (laptop turn `present`s one) → `artifact-gallery` with it; Tools →
  `tools-sheet` listing MCP `demo`; Commands → `commands-sheet`; More → Sessions →
  `drawer` with this session current; More → Session info → `session-info-sheet`; More →
  Scheduled (laptop turn `schedule_create`, approved) → Session info with the wake; More →
  Dictate (Settings → Beta → Dictation on) → the voice card; More → New session → an EMPTY
  transcript. World changes that need a JSON tool call go through the `laptop-prompt`
  hook (`34-hub-laptop.js`): iOS smart punctuation curls quotes typed into the composer.
  Shared sub-flows `_hub-fan.yaml` / `_hub-more.yaml`.
- **`scripts/e2e-gate.sh <udid> [flags]`**: `exec bun apps/mobile/e2e/run.ts --udid …`;
  exit code passes through.

### Files

`apps/mobile/e2e/gate.ts` (new) · `apps/mobile/e2e/run.ts` · `apps/mobile/e2e/flows/34-hub-*.yaml`,
`_hub-fan.yaml`, `_hub-more.yaml`, `34-hub-laptop.js` (new) · flow fixes/tags (Execution) ·
`apps/mobile/test/e2e-gate.test.ts` (new) · `scripts/e2e-gate.sh` (new) ·
`apps/mobile/e2e/README.md` · `TODO.md`.

### Failure modes

- Hung Maestro/XCTest driver → the attempt is killed at the timeout, counted `TIMEOUT`.
- A red flow leaves the app mid-screen or a pairing window open → next attempt
  terminates the app, closes the window, relaunches with `clearState`.
- Simulator shut down → booted; wrong/unknown UDID → exit 2, never another device.
- Build/install fails → its exit code, no flows run (nothing is reported green).
- An untagged flaky flow → counted red (no silent retry); tagging needs a reason.
- A `known-bug` that got fixed → reported as *now passes*, so the tag does not rot.
- Selected nothing (`--only` empty) → every flow (the gate); unknown name → error.

### Tests

`apps/mobile/test/e2e-gate.test.ts`: tag parsing (block/inline, header only), the reason
rule, one-retry-flaky-only, last attempt decides, verdict (known-bug/quarantine not
counted, timeout counted, fixed known-bug surfaced, empty run), the summary table rows and
lists, `majorOfDevice` (unknown/unavailable → undefined), the new CLI flags, and over the
REAL flows: every tag has its reason and every known-bug/quarantine has a `TODO.md` line.
The e2e evidence is the full run in Execution (the known-bug `34-hub-*` red on `main`).

## Execution

*— claude-opus-5-5, 2026-11-18*

(pending the first full run)

### Fix round 1

*— claude-opus-5-5, 2026-11-19* (resumed a stopped DeepSeek attempt: kept its `deviceChoice` and `runAttempt` shape, fixed what did not work)

- **F1 (HIGH) — FIXED.** `TODO.md:36`: an `e2e flow \`34-hub-commands\`` sub-item under
  feat/mobile-hub-commands (the Commands disc sets `commandsOpen`, `SessionScreen.tsx:840`,
  but nothing reads it). Red before: `the real flows' gate tags > every quarantined or
  known-bug flow has a TODO.md line naming it` → `"listed": false` for `34-hub-commands`;
  green after.
- **F2 (MEDIUM) — FIXED.** New pure `deviceChoice` (`gate.ts:110-149`, fn at `:125`): a UDID is validated
  whether or not `--ios` is given; `--ios N --udid X` where X is unknown/unavailable or of
  the other major → exit 2 with a message. `run.ts:323-333` uses it. Tests: 4 in
  `deviceChoice: a UDID is validated with --ios too`. Mutations: (a) the original
  behaviour (`udid === undefined || only !== undefined` → `majors`) → 2 fail; (b) the
  major-mismatch check disabled (`&& false`) → 2 fail. Both reverted.
- **F3 (MEDIUM) — FIXED.** `runAttempt` (`run.ts`, exported for test) spawns the attempt
  `detached: true` (setsid → it leads its own group; probed: `pid 44230 pgid 44230 self
  pgid 44228`, `kill(-pid)` then `pgrep -g` → none) and the timeout SIGKILLs the GROUP
  (`killFlowTree`); the harness `finally` also group-kills each child. DeepSeek's draft
  omitted `detached`, so `kill(-pid)` hit ESRCH and the leader was never killed (the test
  hung to its 5 s timeout). Also fixed in its draft: `children.delete(...children)` (Set
  `delete` takes ONE arg — it dropped the first child, i.e. `serve`, from the reap set
  instead of the attempt) → the attempt's own child is deleted. Tests: `nothing of the
  attempt outlives the timeout` (`sh -c "sleep & sleep"`, 400 ms, then `pgrep` → `[]`, code
  137), `an attempt that ends in time keeps its own exit code`, `killFlowTree never signals
  pid ≤ 1 or its own process`. Mutation: the timeout back to leader-only
  `child.kill("SIGKILL")` → `expected [] / received ["44481","44482"]` (both sleeps
  orphaned). Reverted.
- **F4 (MEDIUM) — PARTIAL.** The only full gate run on disk is
  `.tentacle/tmp/e2e-mobile/1795030151557/` (this worktree, iOS 26, 2026-11-18 21:34, branch
  code before this round): `GATE FAIL — 27 passed, 32 failed, 1 known-bug, 0 quarantined (of
  60; 3917 s)`; `34-hub-commands` reported `FAIL (known-bug)` and listed with its reason.
  Sample causes: `05-daemon-down` *pair-paste-input is visible* false; `33-hub` *hub-glyph is
  visible* false; `34-hub-new` *transcript-empty is visible* false; `22-notify-deny`
  *Element not found: session-…*. Not diagnosed in this round (out of a fix round's scope,
  ~65 min per run). **Unverified:** a green (or triaged) full run on this code, and the
  `34-hub-*` red-on-`main` evidence — verify with `scripts/e2e-gate.sh <udid>` and paste its
  `summary.txt`.

Narrow gate: `bun test apps/mobile/test/e2e-gate.test.ts apps/mobile/test/e2e-flows.test.ts`
→ 73 pass, 0 fail; `bunx biome check` on the 3 changed TS files → clean; `tsc -p apps/mobile`
→ clean.

### Fix round 2

*— claude-opus-5-5, 2026-11-19* (resumed a stopped DeepSeek attempt: kept its `reapAll` + `installSignalReap` shape, fixed its lifetime)

- **R1 (MEDIUM) — FIXED.** `runAttempt` (`run.ts`) now installs a SIGINT/SIGTERM handler
  (`installSignalReap`) for the attempt's life only: it runs `reapAll` (every child, each
  with the group it leads) then exits 130/143; the attempt adds and removes ITSELF in
  `children` (no more `onSpawn`). DeepSeek's draft installed the handler once, for good,
  with `process.once` — after the flows it would pre-empt `E2E_HOLD`'s own SIGINT wait
  (`run.ts` HOLD block) and exit 130 before `summary.txt` is written; now `runAttempt`
  removes it in a `finally`. Tests (`Ctrl+C reaps the attempt's tree`): `nothing of the
  attempt outlives the harness` (a child `bun` runs one attempt `sh -c "sleep & sleep"`, is
  SIGINTed, then `pgrep` → `[]`) and `the reap handler lives only while an attempt runs`
  (listener counts +1 during, back to baseline after). Red: the second test on DeepSeek's
  draft → `after: {int: 1, term: 1}`, expected `0/0`. Mutations: (a) the handler without
  `reapAll()` (= the pre-round behaviour: Bun dies, the group lives) → `survived: [...]`,
  fails; (b) the `finally` without `removeSignalReap()` → the listener test fails. Both
  reverted (`rg MUTATION` → none).
- **F4 (MEDIUM, blocker) — NOT FIXED (escalated).** Needs a ~65 min full simulator run plus
  triage of 32 reds — outside a fix round and this session's budget (no foreground job
  over 10 min, no polling). New evidence on disk since round 1 (DeepSeek, this worktree,
  2026-11-19): `1795044940371` — `05-daemon-down` alone → `GATE PASS — 1 passed` (71 s),
  though it FAILED in the full run, which points at cross-flow state leaking in a full run
  rather than per-flow breakage (hypothesis, not verified); `1795045041132` — the
  `33-hub` + `34-hub-*` six alone → `GATE FAIL — 0 passed, 6 failed` (496 s), so the hub
  reds are real per-flow failures, not ordering. Not triaged. Decision needed from the owner: run
  `scripts/e2e-gate.sh <udid>` and triage in a dedicated round (or split it into its own
  task), since nothing in the code can close F4 without that run.

Narrow gate: `bun test apps/mobile/test/e2e-gate.test.ts apps/mobile/test/e2e-flows.test.ts`
→ 75 pass, 0 fail; `bunx biome check` on the 2 changed TS files → clean; `tsc -p apps/mobile`
→ clean.

## Review

*— claude-opus-5-5, 2026-11-18* (fresh context; same model as the executor: shared blind spots possible)

**Verdict: REQUEST-CHANGES**

Gate: `bun test apps/mobile/test/e2e-gate.test.ts apps/mobile/test/e2e-flows.test.ts` → 65 pass, **1 fail**; `bun run lint` clean; `bun run typecheck` clean. Full `bun run check` not run (this branch's own test is already red).

1. **HIGH — the branch's own test is red.** `apps/mobile/test/e2e-gate.test.ts:231` fails: `34-hub-commands` is tagged `known-bug` (`flows/34-hub-commands.yaml:2-4`) but `TODO.md` has no ``e2e flow `34-hub-commands` `` line — `TODO.md` is in the plan's Files list but not in the diff. `bun run check` fails.
2. **MEDIUM — `--ios N --udid X` drives an unvalidated device.** `run.ts` validates the UDID only when `args.only === undefined`; the loop then uses `udid ?? firstDevice(...)`. A typo'd UDID gives a build/install exit code instead of exit 2 (doc's failure mode "wrong/unknown UDID → exit 2"), and a valid UDID of the other major is driven and reported as iOS N. Validate `majorOfDevice(...) === args.only` too.
3. **MEDIUM (plausible, not reproduced) — timeout kills only Maestro's direct process.** `spawnFlow` `child.kill("SIGKILL")` hits the `maestro` launcher/JVM; it is not spawned in its own process group, so an orphaned XCTest driver / `xcodebuild` can survive and hold the simulator's driver port for the next flow — the very hang the timeout is meant to bound. Verify with `pgrep -fl xctest` after a forced timeout; kill the group if it survives.
4. **MEDIUM — Execution is empty** ("pending the first full run") while code comments cite "the first/second gate run"; the evidence the Tests section promises (full run, `34-hub-*` red on `main`, `STEADY_MS` change) is not in the doc.

Mutations (each reverted, tree byte-identical, `git status` clean): `shouldRetry` `=== 1`→`<= 2` → caught; `verdictOf` ignoring `known-bug` → caught (4 tests).
Attacks with no finding: tag parsing (block/inline/reason-without-tag), `quarantine`+other exclusivity, last-attempt-decides, port 4000 guard, hooks routing (pinned by a union-vs-`hookFor` test). §7 invariants: none touched (harness/tooling only).
Executor: careful pure-module split and tests, but declared done-able with its own test red and Execution unwritten.

### Round 2

*— claude-opus-5-5, 2026-11-19* (fresh context; same model family as the round-1 fixer)

**Verdict: REQUEST-CHANGES**

Gate: `bun test apps/mobile/test/e2e-gate.test.ts apps/mobile/test/e2e-flows.test.ts` → 73 pass, 0 fail; `bun run lint` clean; `bun run typecheck` clean.

- **F1 — FIXED.** `TODO.md` names ``e2e flow `34-hub-commands` ``; the TODO test is green.
- **F2 — FIXED.** `deviceChoice` (`gate.ts`) refuses an unknown UDID or one from the other major, whether or not `--ios` is given. Mutation (major-mismatch check → `if (false)`) → 2 tests fail; reverted.
- **F3 — FIXED.** `runAttempt` uses `detached: true` plus a group kill. Mutation (`detached: false`) → `nothing of the attempt outlives the timeout` fails; reverted. `git status` clean afterwards.
- **F4 — OPEN (now the blocker).** The only full run on record is `GATE FAIL — 27 passed, 32 failed` of 60, and none of the 32 is triaged. A gate that is always red cannot refuse a publish (the Context's own goal), and `34-hub-new` (the reported bug) is neither tagged `known-bug` nor shown red on `main`. Needed: triage every red (fix it, or tag it with a reason and add a TODO line), then paste a `summary.txt` from this code.
- **R1 (MEDIUM, new regression) — Ctrl+C now leaves Maestro running.** `detached: true` takes the attempt out of the terminal's process group, and `run.ts` installs no SIGINT handler (the only one is for `E2E_HOLD`, `run.ts:817`). Ctrl+C therefore ends Bun without its `finally`, so `killFlowTree` never runs. The Maestro JVM and XCTest driver keep driving the simulator. Before this round they got the terminal's SIGINT. Fix: on SIGINT/SIGTERM, kill each attempt's group (e.g. through the `finally`) before exiting.

What holds: `killFlowTree` refuses pid ≤ 1 and its own pid. The `finally` group-kill is harmless for `serve`: it leads no group, so the kill gets ESRCH, which is caught. `children.delete(attempt)` keeps `serve` in the reap set.

### Round 3

*— claude-opus-5-5, 2026-11-19* (fresh context; same model family as the round-2 fixer)

**Verdict: REQUEST-CHANGES** (the code findings are closed; only F4 is left, and it needs the owner's decision)

Gate: `bun test apps/mobile/test/e2e-gate.test.ts apps/mobile/test/e2e-flows.test.ts` → 75 pass, 0 fail; `bun run lint` clean; `bun run typecheck` clean.

- **R1 — FIXED.** `installSignalReap` (`run.ts`) is installed only while an attempt runs, and its handler is `reapAll` then exit 130/143. Mutations, each reverted: (a) handler without `reapAll()` → `nothing of the attempt outlives the harness` fails; (b) `finally` without `removeSignalReap()` → `the reap handler lives only while an attempt runs` fails. Afterwards: `git status` clean, and `pgrep` finds no stray `sleep 9…`.
- **Regressions checked, none found.** (1) Between attempts (build, setup) no handler is installed; Ctrl+C then reaches `serve` and the other non-detached children through the terminal's process group, as before. (2) `E2E_HOLD`'s own SIGINT wait is no longer pre-empted (the listener count is back to its baseline after each attempt). (3) A SIGTERM during an attempt now also reaps `serve`, which it did not before (an improvement). (4) The attempt adds and removes itself in `children`, and `serve` stays in it.
- **F4 — still OPEN, escalated.** No triaged full run exists. New data: `05-daemon-down` passes alone but fails in the full run (likely state leaking between flows, unverified), and `33-hub` + the five `34-hub-*` flows run → all 6 fail even alone. Until the reds are triaged, the gate cannot be the iOS publish gate. Owner's decision: triage in a dedicated round, or merge the harness as is (no gate wired to the iOS publish yet) and split the triage into its own task (`fix/mobile-e2e-reds`) — I recommend the split, since the harness code itself now reviews clean.
