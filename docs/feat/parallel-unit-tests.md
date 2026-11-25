# feat/parallel-unit-tests — Run the unit suite across cores

> **Status:** implementation approved (self, M)
> **Branch:** `feat/parallel-unit-tests`
> **Size:** M · **Blast:** cross-module (the test gate every task depends on) · **Suited:** Opus plan → DeepSeek exec → fresh Opus review
> **Changelog:** none (dev/test-only)

## Context

**Problem.** The full unit suite is the slowest step of every gate: `Ran 17881 tests across 1253 files. [529.67s]`
(`.tentacle/tmp/mobile-open-long-session-gate-main.log`, 24/11) — ~9 min, run several times per task
(branch gate, fix rounds, the merge gate on main via `bun run check`). `bun test` runs every file in one
process; the machine has 14 cores. The owner (25/11) asked to speed tasks up; this is lever 4 of that
discussion (levers 1–3 were orchestration-only: two-simulator e2e gate, branch gates on touched
packages + changed e2e flows only, full unit suite only on the main merge gate).

**Goal.** `bun test` (and therefore `bun run check`) keeps meaning "the whole suite, same pass/fail
verdict", but finishes in a fraction of the time by running shards concurrently. Target: ≤ 3 min on this
machine, measured.

**Constraints.**
- Same verdict as today: every file runs exactly once; a failure anywhere fails the run with a readable
  summary (which shard, which file, the failing test output) — no lost or duplicated files, no swallowed
  exit codes.
- The test env guard (`bunfig.toml` preload `scripts/test-preload.ts` / `scripts/test-env-guard.ts`) applies
  to every shard; the opt-in env vars (`TENTACLE_K8S_SERVER`, `TENTACLE_DOCKER_TESTS=1`,
  `TENTACLE_SLOW_TESTS=1`) keep working.
- Tests that share global resources (ports, temp dirs, the HOME temp dir, sockets, file locks) must not
  collide across concurrent shards — find them, prove isolation or keep them in one shard.
- Deterministic (owner: AI-free automated gates are our strength): sharding stable across runs, flake
  rate not worse than today — measure it (e.g. 5 consecutive full runs).
- CI keeps working (`--filter '!@tentacle/mobile'` install); `bun test <path>` for a single file/dir
  unchanged for iteration (AGENTS §4).
- AGENTS.md §4/§6 updated if the meaning or timing of the commands changes (a rule-text change rides
  this branch).

*— claude-opus-5-5, 2026-11-25 (orchestrator)*

## Implementation

**APPROVED (self, M, orchestrator rule)** — no owner-visible choice: the gate keeps its meaning, only its
speed and its strictness change (it now also catches crashed files and files that pass only alongside
others).

### Measurements (this machine, 14 cores, Bun 1.4.3, worktree at `ef4a38bb`)

The machine was shared (an Xcode build and other agents; load avg 12–35 throughout), so absolute numbers
are pessimistic; the ratios are what matter. Logs + scripts: `.tentacle/tmp/parallel-unit-tests/`.

| run | command | wall | verdict |
|---|---|---|---|
| serial baseline | `bun test --timings=… --update-timings` | **596.3 s** (user 97 s + sys 43 s = 140 s CPU) | 17876 pass · 5 skip · 0 fail · 17881 tests · 1253 files |
| P14 ×4 (recorded timings) | `bun test --parallel --timings=<serial timings>` | **50.8 · 52.1 · 52.9 · 52.7 s** (user 141 s + sys 52 s) | 17877 tests · 1253 files; fails: see below |
| P14 ×1 (no timings) | `bun test --parallel` | 65.5 s | idem |
| P8 ×3 (recorded timings) | `bun test --parallel=8 --timings=…` | 74.5 · 75.6 · 75.6 s | idem |

- **The suite waits, it does not compute**: 140 s CPU in 596 s wall (23 %). That is why 14 workers give
  ×11.5, not ×4.
- **Per package (serial sum, files)**: tui 276.8 s (215) · cli 96.7 s (180) · scripts/test 88.2 s (11) ·
  daemon 40.6 s (106) · apps/mobile 28.2 s (323) · client 18.4 s (87) · apps/relay 15.8 s (9) · tools
  10.4 s · exec 6.3 s · docker 4.4 s · agent 4.0 s · the other 7 packages < 2 s each.
- **Per file**: 930 files ≤ 0.1 s (10 s total); 26 files > 5 s carry 336 s (56 %). Slowest:
  `scripts/test/release.test.ts` 74.3 s (35.1 s under P14) · `packages/tui/test/app.test.tsx` 33.2 ·
  `tui/send-now-app` 19.8 · `daemon/serve-log-store` 18.4 · `relay/server` 15.3 · `cli/serve-limits` 13.3 ·
  `cli/attach-run` 12.5 · `scripts/test/install` 11.8 · `tui/connect-functest-f` 11.2 ·
  `tui/connect-model-error` 11.1. The critical path is ~35 s (release.test.ts under P14): ≤ 3 min is met
  with ×3 margin; slowest-first scheduling (recorded timings) is worth 65.5 → 52 s.
- **Same files, no loss, no double**: the per-file key sets written by the serial run and by a P14 run
  (`--update-timings`) are identical — 1253 = 1253, `only-serial: []`, `only-parallel: []`.
- **17881 vs 17877 tests**: one file (`apps/mobile/test/artifact-card-render.test.ts`, 5 tests) fails to
  LOAD under `--parallel` and is reported as one `(unnamed)` failure (17881 − 5 + 1). See class C.
- **Failures under P14/P8** (8 parallel runs, 4 had at least one): deterministic —
  `artifact-card-render` (8/8); flaky — `client/ws-factory` (1), `agent/history-validity-e2e` (1),
  `cli/output-streams` (1), `cli/context-reset-e2e` (2), `cli/engine-runtime` (1). Each of the flaky ones
  passes alone (`bun test <file>`, `--isolate`, `--parallel=1`: all green; `context-reset-e2e`
  `--rerun-each=40`: 40/40). For comparison, the serial gate logs under `.tentacle/tmp` (~200 runs): 178
  with 0 fail, 17 with 1, 3 with 2 (an upper bound on serial flakiness: it includes real failures) —
  `context-reset-e2e` is among the serial flakers too.
- `git status` stays clean after 9 full parallel runs: no test writes into the tree.

### Load-bearing assumption

**Test files are independent enough to run in concurrent processes.** Verdict: **true once three classes
of defect are fixed** (all in test code, none in product code), and each is proven:

- **A — a fixed short sleep used as a synchronisation point.** `await new Promise((r) => setTimeout(r, 20))`
  then an assertion on an effect another task produces (a laptop save, a `stop` hook being installed).
  Under CPU contention 20 ms is not enough. Observed: `context-reset-e2e.test.ts:181` (saw "Interrupted…"
  instead of the final message), `engine-runtime.test.ts:490` (0 records instead of 1),
  `output-streams.test.ts:213` (`stop` still the no-op → the test hangs to its 5 s timeout). Same shape,
  not yet observed: `engine-runtime.test.ts:1597`, `engine-docker.test.ts:412`,
  `local-runtime.test.ts:310`, `local-runtime.test.ts:1931`.
- **B — loopback-port theft across processes (proven).** `Bun.serve({ port: 0 })` binds dual-stack
  `*:P`; on macOS a later bind on `127.0.0.1:P` by ANOTHER socket SUCCEEDS and takes all IPv4 traffic to
  `127.0.0.1:P` (repro `steal.ts`: `rebind on 127.0.0.1:56304 SUCCEEDED · 127.0.0.1 -> 502 thief ·
  localhost -> 200 victim`). Port-0 allocation itself never collides (repro `collide.ts`: 3000 dual-stack
  + 3000 IPv4 port-0 binds, 0 collisions), so theft needs a bind on an EXPLICIT port that was probed or
  freed earlier — which four sites do:
  - re-bind the same port after a stop: `packages/client/test/ws-factory.test.ts:103-122`
    (`startWsServer` on 127.0.0.1:0, stop, restart on the same `port`) and
    `packages/cli/test/connect-model-error.test.ts:84-89` (`freePort`: bind, read, stop) used at `:326`
    (`startDaemon({ host: "127.0.0.1", port })`, restarted on it later);
  - dial a probed-then-closed port expecting "refused": `apps/mobile/test/connection.test.ts:203-208`
    (`freeLoopbackAddress`, used at `:501, :927, :955, :988`) and
    `packages/docker/test/byte-duplex.test.ts:328-334`. Under concurrency another worker may own that
    port by then → "opened" instead of "refused".
  Observed: `ws-factory.test.ts:65` got `rejected` (someone else's server) instead of `unauthorized` from
  its OWN server. `history-validity-e2e` (`ECONNREFUSED` on `localhost:<its port>`, then
  `usage.exact === false`) fits a victim of the same class but is **not proven**; see Validation.
  This class already exists today between concurrent gates of different worktrees; parallel shards just
  make it frequent.
- **C — a file that passes only after another file.** `apps/mobile/test/artifact-card-render.test.ts`
  fails ALONE even serially today (`bun test <it>` → `SyntaxError: Export named 'TextInput' not found in
  module …/react-native/index.js`): its `mock.module("react-native", …)` (`:65-95`) lacks `TextInput`,
  which something TranscriptRow imports needs; the serial gate passes only because an earlier file left a
  fuller mock in the shared module registry. `--parallel` implies `--isolate` (fresh global + module
  registry per file), so it fails 8/8. This is a real latent bug the parallel gate now catches.

Every other shared global resource, and why it is isolated:

| resource | finding | isolation |
|---|---|---|
| `HOME`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `DOCKER_CONFIG` | set by the preload (`scripts/test-env-guard.ts:38-67`) | **proven per FILE** under `--parallel`: the preload runs before each file in its worker; probe printed 6 distinct `tentacle-test-home-*` for 6 files over 3 workers |
| `TENTACLE_*` stripping + opt-ins | `test-env-guard.ts:42-55` | probe with `TENTACLE_SLOW_TESTS=1 TENTACLE_X=leak`: every file saw `slow=1 x=undefined`; workers inherit the parent env, the preload re-applies per file |
| `process.env` mutation, `process.chdir` | 52 test files mutate env | per worker process, reset of `TENTACLE_*`/`HOME`/`XDG_*` per file by the preload; strictly less leakage than the serial single process |
| temp dirs | every test dir found is `mkdtemp(join(tmpdir(), …))` (unique) | `TMPDIR` shared, names unique |
| `$TMPDIR/tentacle-<uid>/…` | tool-output fallback (`packages/agent/src/tool-output.ts:121`, only when `HOME` is unwritable — it never is under the guard), control sockets (`packages/cli/src/relay.ts:198`, hashed from a per-test config dir) | unique names; unchanged from today |
| fixed `/tmp/...` strings | `apps/mobile/test/*-link.test.ts` `CWD = "/tmp/mobile-…"` | strings passed to fakes (`writeFile: async () => {}`), never created |
| fixed ports | every `port: 4000…`-style literal is a record/URL value, never bound (no `Bun.serve`/`listen` on a literal port in any test) | n/a |
| loopback port space | class B | fixed by this task (Design §4) |
| repo tree | no test writes into it (`git status` clean after 9 runs) | n/a |
| live infra (opt-in only) | live-k8s / live-docker hit one real cluster/engine | opt-in, run by hand; if they contend, run them by path (`bun test <path>`, serial) — documented, not automated |

### Preconditions (verified)

- **Bun 1.4.3 has a native file-level parallel runner** (`bun test --help`): `--parallel=<N>` ("N worker
  processes; implies --isolate; defaults to CPU core count"), `--timings=<json>` ("makes --parallel start
  the slowest files first"), `--update-timings`. Required Bun is already pinned ≥ 1.4.3
  (`package.json` `engines.bun`, `.github/workflows/build.yml:29`).
- Probed behaviour (`.tentacle/tmp/parallel-unit-tests/probe/`):
  - a failing file → its failure printed under its file header, aggregated summary, **exit 1**;
  - a file calling `process.exit(0)` → `✗ x-exit.test.ts (worker crashed: exit code 0)`, a SIGKILLed one →
    `(worker crashed: SIGKILL)`, both counted as fails, **exit 1**. The SERIAL runner, given the same
    `process.exit(0)` file, **exits 0 silently** — today's gate can be fooled this way, the parallel one
    cannot;
  - a missing `--timings` file is fine (treated as empty, created by `--update-timings`); an invalid one is
    a hard error; a stale entry (file gone) is ignored; more workers than files is fine;
  - explicit paths `./x.fixture.ts` run even without `.test.` in the name, and are NOT picked by discovery
    (a `bun test` over the dir still ran only the 4 `*.test.ts`).
- CI runs no tests: `.github/workflows/build.yml` only installs, compiles, smoke-tests `--version`
  (`:50-66`). No CI change.
- Single-path iteration: package `bunfig.toml`s (`packages/*/bunfig.toml`) and the root `bunfig.toml:1-2`
  are untouched; `bun test <path>` stays serial and identical.

### Design

1. **Mechanism: Bun's own `--parallel`, no custom shard runner.** Discovery is Bun's (same code path as the
   serial run — the thing a self-written lister could drift from), scheduling is a work queue over
   anonymous workers (no fixed shards ⇒ no unbalanced or empty shard), each file in a fresh global, the
   summary and exit code are Bun's. A hand-rolled N-process runner would re-implement exactly the parts
   this task must not get wrong (discovery, summary, exit code) and still be slower (static shards vs work
   stealing).
2. **Commands.** `package.json:13` `"test": "bun test --parallel --timings=scripts/test-timings.json"`
   (so `bun run test` and `bun run check`, `package.json:18`, are parallel) and a new
   `"test:timings": "bun test --parallel --timings=scripts/test-timings.json --update-timings && biome format --write scripts/test-timings.json"`.
   Bare `bun test` (and `bun test <path>`) stays the serial runner: iteration unchanged (AGENTS §4).
   Worker count = Bun's default (core count): fastest measured (52 s vs 75 s at 8), and the flake gap
   between 8 and 14 workers was nil once class A/B is counted (both had flakes).
3. **Balancing: recorded durations, committed.** `scripts/test-timings.json` (`{ "version": 1, "files":
   {…} }`, ~1260 lines) is committed and READ by `bun run test` (never written by it: a gate run must not
   dirty the tree or create cross-branch conflicts). It only orders the queue (slowest first); a missing or
   stale entry changes the order, never the verdict. Refresh by hand with `bun run test:timings` when
   files are added/renamed in bulk (the orchestrator, e.g. at release). Measured value: 65.5 → ~52 s.
4. **Fix class B (port theft) at its four sites**, so nothing in the suite binds an explicit port in the
   ephemeral range:
   - "dial a closed port": use `127.0.0.1:1` (port 1 is never handed out by port-0 allocation and no test
     binds it; `ws-factory.test.ts:71` already does this) in `connection.test.ts:203` (`freeLoopbackAddress`
     returns `ws://127.0.0.1:1/e2e`) and `byte-duplex.test.ts:328-334` (dial `tcpEp(1)`, expect
     `connection refused by 127.0.0.1:1`);
   - "restart on the same port": take the port from OUTSIDE every ephemeral range (macOS 49152–65535
     `sysctl net.inet.ip.portrange`, Linux 32768–60999): a random port in 20000–29999, retried on
     `EADDRINUSE` (≤ 50 tries), then bound on `127.0.0.1` for BOTH lifetimes. A port-0 server of another
     worker can never be given such a port, so the re-bind cannot steal; two tests picking the same one
     collide loudly (`EADDRINUSE` on first bind → retry), never silently. Sites: `ws-factory.test.ts:103`
     (first `startWsServer` on the picked port, not 0) and `connect-model-error.test.ts:84-89`
     (`freePort` → the picker). One small helper per package that needs it (client, cli) — two copies of
     ~10 lines beats a cross-package test import.
5. **Fix class A (sleep-as-sync) at its seven sites**: replace the sleep with a poll on the very condition
   asserted next, with a timeout that THROWS (the `until` contract of
   `packages/client/test/support/fakes.ts:107-121`): for saves, poll `(await store.loadAll()).records`
   until the expected record/last message is there (an async-predicate variant; add `untilAsync` next to
   `until` in `fakes.ts`, or a local helper in the cli file if the import is not already there); for
   `output-streams.test.ts:213`, poll until `stop` has been replaced (a flag set inside the
   `queueMicrotask`). Assertions after the wait stay unchanged (they still pin the exact content).
6. **Fix class C**: complete the `react-native` mock in `artifact-card-render.test.ts:65-95` with the
   exports its import graph needs (`TextInput` and anything else the alone-run reports next), the same
   shape the other mobile render tests' mocks use (e.g. `apps/mobile/test/text-seam-harness.ts`).
7. **Gate wiring test** `scripts/test/test-gate.test.ts` (see Tests): pins that the `test` script is the
   strict runner (counts a crashed file as a failure, exits non-zero, names the file).
8. **Rule text** (rides this branch): AGENTS.md §4 `:76` "full `bun test`" → "full `bun run test`"; §6
   `:99` the `bun test` bullet becomes `bun run test` — full suite, parallel (`bun test --parallel`, one
   worker per core, each file in a fresh global, ~1 min here) — with bare `bun test` = the same files
   serially (~10 min, only to bisect an isolation question), and the baseline sentence unchanged; §9 gains
   one bullet: *no fixed sleep as a synchronisation point (poll the condition with a throwing timeout); no
   probe-then-reuse of a loopback port (closed port ⇒ `127.0.0.1:1`; restart on a port ⇒ pick outside the
   ephemeral range)*.

### Files (dependency order)

1. `apps/mobile/test/artifact-card-render.test.ts` — mock completed (C).
2. `packages/client/test/support/fakes.ts` — `untilAsync` (if used by cli; else local helper).
3. `packages/client/test/ws-factory.test.ts`, `packages/cli/test/connect-model-error.test.ts`,
   `apps/mobile/test/connection.test.ts`, `packages/docker/test/byte-duplex.test.ts` — B.
4. `packages/cli/test/{context-reset-e2e,engine-runtime,engine-docker,local-runtime,output-streams}.test.ts` — A.
5. `scripts/test/fixtures/test-gate/{passes,fails,exits}.fixture.ts` + `scripts/test/test-gate.test.ts`.
6. `scripts/test-timings.json` (generated by `bun run test:timings`, Biome-formatted), `package.json`
   (`test`, `test:timings`).
7. `AGENTS.md` §4/§6/§9. No changelog fragment (dev-only), no protocol note.

### Failure modes

| mode | behaviour | how it converges |
|---|---|---|
| a file crashes its worker (`process.exit`, signal, segfault) | `✗ <file> (worker crashed: …)`, counted as a fail, exit 1 | stricter than today (serial exits 0 on `process.exit(0)`); pinned by the gate test |
| a test hangs asynchronously | per-test 5 s timeout, unchanged | as today |
| a test spins synchronously (`while(true)`) | the run never ends (probe: alive after 25 s with `--timeout=2000`) — **same as serial today** | debt (Notes); no native worker timeout in Bun 1.4.3 |
| a file added later | discovered by Bun (no list to maintain); not in timings → queued with no recorded duration; verdict unaffected | `bun run test:timings` refreshes the order |
| a file removed/renamed | stale timings entry ignored (probe) | idem |
| empty shard / imbalance | impossible by construction (work queue, not static shards) | — |
| test fails only TOGETHER (leak from a previous file) | `--isolate` gives each file a fresh global + module registry; env reset per file by the preload | stricter than serial |
| test fails only ALONE (depends on a previous file) | now FAILS the gate (class C) | must be fixed in the test; serial `bun test` can be used to confirm "passes only together" |
| timing-sensitive test under contention | more frequent than serial (4/8 runs before the fixes) | classes A/B fixed; NO `--retry` (a retry would hide exactly the bugs the owner's AI-free gate must surface); any new flaker in Validation → reproduce + fix in this branch if it is class A/B, else STOP and report |
| machine already loaded (other gates, Xcode) | slower, still ≥ ×8 measured at load 20–35 | — |
| opt-in live tests in parallel | live-k8s/docker files may run concurrently against one real target | opt-in, by hand; run them by path if they contend (AGENTS §6 note) |
| `scripts/test-timings.json` invalid/corrupt | `bun test` errors before running anything (probe), exit 1 — loud | regenerate with `bun run test:timings` |

### Tests (red first)

- **T1 gate strictness** — `scripts/test/test-gate.test.ts`: reads `scripts.test` from the root
  `package.json`, spawns it (`bun run test -- ./scripts/test/fixtures/test-gate/passes.fixture.ts
  ./…/fails.fixture.ts ./…/exits.fixture.ts`, cwd repo root, timeout ~30 s) and asserts: exit code ≠ 0;
  output names `fails.fixture.ts` with its failing test and `exits.fixture.ts` with `worker crashed`;
  summary `1 pass` / `2 fail`. Second case: `passes.fixture.ts` alone → exit 0 (the script is not "always
  red"). **Red** on today's `"test": "bun test"`: the serial runner dies inside `exits.fixture.ts` and
  exits 0 (probe above) → assertion 1 fails. Fixtures are `*.fixture.ts` so the suite never discovers
  them.
- **T2 class C** — red today: `bun test apps/mobile/test/artifact-card-render.test.ts` → 0 pass 1 fail
  (`TextInput`); green after the mock is complete, alone AND in the full parallel run.
- **T3 class A/B non-vacuity** — for each changed file, before the fix, run it under contention
  (`bun test --parallel=14 --rerun-each=30 <file>` while 14 `yes > /dev/null` CPU burners run) and record
  the fail count; after the fix, the same command 0 fails. Where the before-count is 0 (rare races), mutate
  instead: shorten the poll timeout to 1 ms and confirm the test now fails loudly with the `until … timed
  out` message (proves the wait is real and throws, not vacuous). Record both in Execution.
- **T4 class B guard (reviewer-run, not a test)** — `rg -n -A3 "\.port;?$" --glob '**/test/**' | rg -B1
  "stop\("` returns only the fixed sites with their new shapes.

### Validation (Execution must record)

1. File-set self-check on the final branch: `bun test --parallel --timings=<scratch>/a.json
   --update-timings` vs one serial `bun test --timings=<scratch>/b.json --update-timings`: identical key
   sets, same test count (17881 + the new T1 tests), same pass/skip counts (the 3 opt-in skip groups = 5
   skipped tests).
2. **5 consecutive `bun run test`** (no other gate of ours running): wall time + verdict each, all 0 fail.
   Target ≤ 3 min each (measured ~52 s). A flake in any run → reproduce (T3 method), fix if class A/B,
   restart the 5-count; a flaker of an unknown class (e.g. `history-validity-e2e` if it recurs after B) →
   STOP and report (two-strike rule) rather than retry it away.
3. `bun run check` green (typecheck → lint → parallel test); `git status` clean after the runs except the
   intended diff.

### Notes / debt

- 255 short fixed sleeps in 101 test files remain; only those that SYNCHRONISE on another task's effect
  and were observed or have the identical shape are fixed. The §9 bullet stops new ones; others get fixed
  when they flake.
- A synchronous hang hangs the gate forever (as today). A wall-clock watchdog around `bun run test` was
  left out: Bun has no worker timeout, and a wrapper killing the whole run would need its own tested
  process-group handling; revisit if it ever bites a night run.
- Dual-stack `port: 0` servers stay as they are (hundreds of sites); after Design §4 nothing in the suite
  binds an explicit ephemeral port, so they cannot be robbed by the suite. Another *process* on the
  machine binding `127.0.0.1:P` explicitly still could — as today.

*— claude-opus-5-5, 2026-11-25 (planner)*

## Execution

Executed in two passes: DeepSeek wrote most of the working tree and was stopped by the watchdog (the
same call ×4); claude-opus-5-5 reviewed every hunk of that partial diff against the Design, kept it,
finished T1 and ran the checks below. Nothing was committed.

**Load-bearing check (re-run).** The three defect classes reproduce on the pre-fix code and go away
with the fix: C → T2 red/green below; A → the mutations below; B → by construction (T4 guard empty;
theft repro `steal.ts` from planning). Files: the timings keys = the test files on disk (1254 = 1254,
`missing []`, `stale []`: 1253 + `test-gate.test.ts`).

As built, in plan order:

1. **C** — `apps/mobile/test/artifact-card-render.test.ts:99-104`: `mock.module("../src/ui/Text.tsx", …)`
   → `{ Text: "Text", TextInput: "TextInput" }`. **Drift:** the Design said to add `TextInput` to the
   `react-native` mock. The missing import comes from the text seam (`src/ui/Text.tsx`, which calls
   `useContext`, and a walker that never renders can't provide that), so the file now stubs the seam
   the way 8 sibling render tests already do (`row-a11y`, `commands-sheet`, `notice-row`, …).
2. `packages/client/test/support/fakes.ts:124-140` — `untilAsync` (same contract as `until`: throws
   on a timeout). The cli files don't import client test support, so each one got a local 8-line
   `untilAsync`/`until` instead (the Design allowed this). The shared one stays as the helper the
   AGENTS §9 rule names.
3. **B** — `ws-factory.test.ts:82-110` `restartPort`/`startOn` (random 20000–29999, bound for real on
   127.0.0.1, retried ≤ 50 times on a throw), used at `:133`. `connect-model-error.test.ts:83-103`
   `startOnFreePort(config)` replaces `freePort` and starts the first daemon itself (the bind is the
   probe), used at `:340`. `connection.test.ts:206-208` → `ws://127.0.0.1:1/e2e`.
   `byte-duplex.test.ts:328-334` → `tcpEp(1)`, `connection refused by 127.0.0.1:1`.
4. **A** — each sleep now polls the exact content asserted next, not just "a record exists":
   `context-reset-e2e.test.ts:195-203` (last message `=== "done on the fresh context"`; the store
   briefly holds the mid-turn "Interrupted…" note), `engine-runtime.test.ts:488-496, 1601-1608`,
   `engine-docker.test.ts:425-430`, `local-runtime.test.ts:322-329`. `local-runtime.test.ts:1950-1953`
   waits for `tui.runtime.holdsSession(UID)` (the hand-over landed). `output-streams.test.ts:213-235`
   waits for `stop !== noop` (the SIGINT handler is installed), with `stop()` in a `finally`.
5. **T1** — fixtures `scripts/test/fixtures/test-gate/{passes,fails,exits}.fixture.ts` +
   `scripts/test/test-gate.test.ts` (3 tests). I added the `1 pass` / `2 fail` summary assertions the
   plan lists, which the partial diff lacked.
6. `package.json:13-14` `test` / `test:timings` exactly as in the Design. `scripts/test-timings.json`
   is committed (1254 entries, Biome-clean).
7. `AGENTS.md` §4 `:76`, §6 `:99-112`, §9 `:417-426` as in the Design (§6 also says parallel is
   stricter, and names the gate test).
8. **Drift:** a changelog fragment `changelog.d/parallel-unit-tests.changed.md` was written because
   the owner's executor instructions require one. The header's "Changelog: none" is superseded.

**Evidence.**
- T2 red (Text mock removed): `bun test apps/mobile/test/artifact-card-render.test.ts` → `SyntaxError:
  Export named 'TextInput' not found in module …/react-native/index.js` · `0 pass 1 fail`. Green:
  `5 pass 0 fail`, serially AND with `--parallel`.
- T1 red (`"test": "bun test"` put back temporarily): `(fail) … not the bare serial runner` (`Expected:
  not "bun test"`), `(fail) … both fail, both named, exit non-zero` (`Expected: not 0`, i.e. the
  serial runner exited 0) · `1 pass 2 fail`. Green: `3 pass 0 fail`. Gate output over the 3 fixtures
  ends `1 pass · 2 fail · error: script "test" exited with code 1`.
- All 11 touched test files together: `Ran 315 tests across 11 files` · `0 fail`.
- **T3 mutations (class A).** (a) Poll timeout set to 1 ms in all 5 helpers. Idle serial run: `253
  pass 0 fail`; the condition already holds at the first check, so that run proves nothing. Under
  `bun test --parallel --rerun-each=20 <5 files>`: `4678 pass · 3 fail`, 2× `untilAsync: timed out
  after 1 ms` (`context-reset-e2e`, `engine-docker`). So the wait is load-bearing there under load.
  (b) Predicate forced never-true (`|| true`): each of the 7 sites fails loudly with `timed out after
  3000 ms` (startPodRuntime, startAttachRuntime, serve D2, Docker engine, context reset, local persist,
  N-clients hand-over). So no wait can pass vacuously. Both mutations were reverted (`git diff
  --numstat` matches the pre-mutation counts).
- **Not run: the CPU-burner before/after counts from the T3 plan** (14× `yes`). Every site was instead
  covered by mutations (a) + (b).
- **T4:** `rg -n -A3 "\.port;?$" --glob '**/test/**' | rg -B1 "stop\("` → empty.
- Lint: `bunx biome check <17 changed files>` → `No fixes applied`, clean.

**Not run by the executor (owner rule: the orchestrator's gate script runs the full suite).** None of
Validation 1–3 was run here: the serial-vs-parallel file-set run, the 5 consecutive `bun run test`, and
`bun run check`. Those numbers must come from the gate run. If any run flakes, apply the Failure-modes
rule: fix it here if it is class A/B, otherwise STOP and report.

*— claude-opus-5-5, 2026-11-25 (executor, resuming DeepSeek's partial pass)*

## Review
