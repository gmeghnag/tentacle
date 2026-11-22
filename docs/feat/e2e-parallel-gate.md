# feat/e2e-parallel-gate — the mobile e2e gate on two simulators, one build

Type: feat · Size: M · Blast: cross-module (test infrastructure: `scripts/e2e-gate.sh`, `apps/mobile/e2e/run.ts`, orchestration launchers; no app/runtime code) · Suited: Opus plan → DeepSeek exec → Opus review + Opus live validation

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-22*

Owner 22/11 ~23:30: «ad oggi tutti i test UI mobile ci impiegano tantissimo tempo» → chose, of four proposals, **(1) two simulators in parallel** and **(2) one Release build reused** — «subito»; (3) affected-flows selection only as a TODO idea (`eval/e2e-affected-flows`).

Evidence: the last full gate `GATE PASS — 58 passed, 0 failed, 0 known-bug, 7 quarantined (of 65; 4221 s)` (`.tentacle/tmp/orchestration/runs/e2e-gate-2211c.log`) — ~70 min of flows, plus a Release `xcodebuild` (~10–15 min) per gate, run before every iOS publish (`run-gate-build-2211*.sh` → `scripts/e2e-gate.sh <udid>` → `bun apps/mobile/e2e/run.ts`). Two simulators exist on this Mac: iPhone 17 Pro `0FA4B51F-A0E3-421B-BE66-CE29EF45213D` and iPhone 17 Pro Max `0B43D716-9670-421A-BE51-9162004F2963`. `run.ts` already takes `--app <path.app>` (`run.ts:76-83`, install at `:811`) and `--only a,b` / `E2E_ONLY_FLOWS` (`:1545-1565`, `FLOWS` at `:1405`).

Goal: the SAME full suite (nothing skipped, same PASS/FAIL semantics, same summary + per-flow artefacts, same exit codes) in about half the wall time, by (1) building the Release app ONCE and installing it on both simulators, and (2) splitting the flows between the two, balanced by each flow's last recorded duration, each half with its own `serve`/port/mock model and its own Maestro device so the halves cannot see each other. One merged summary table and one exit code. A flow that depends on another flow's state must stay on the same shard (find out which, if any). Also: reuse the built `.app` across runs when the app inputs are unchanged (key it honestly — a JS change changes the Release bundle), so a task's `--only` shots and the publish gate do not each rebuild the same tree.

Constraints: the single-simulator form `scripts/e2e-gate.sh <udid>` keeps working unchanged (the launchers use it); the new form is opt-in (e.g. `scripts/e2e-gate.sh <udid1>,<udid2>`) and then the build launchers switch to it. Quarantined/known-bug semantics unchanged. Deterministic: no AI in the gate. Owner principle: deterministic test gates are our strength — the gate must not get weaker to get faster.

## Implementation

*— claude-opus-5-5 (planner), 2026-11-22*

All `file:line` refer to this branch at `c5a43b60`. `run.ts` = `apps/mobile/e2e/run.ts`, `gate.ts` = `apps/mobile/e2e/gate.ts`.

### Load-bearing assumption

**Two `run.ts` processes, each pinned to its own simulator, can run their flows at the same time and not see each other.** The audit below covers every port, path and piece of shared state one run touches. One item could not be proved from the source and is **Step 0**, a live experiment the orchestrator runs **before any code is written**.

| Resource | Where | Shared between two processes? |
|---|---|---|
| Run dir | `runId = Date.now()` → `RUNS_DIR/<runId>` (`run.ts:363-366`) | **Collides** if two processes start in the same ms. Design: the parent gives each child its own dir (`--shard-of`, below). |
| `serve` port | `freePort()` binds `:0` and releases it (`run.ts:263-270`, `:394`); side `serve` `:599`, project B `:572` | Ephemeral, so not shared. But it is **TOCTOU**: if another process grabs the port between `freePort` and `serve`'s bind, `serve` dies with EADDRINUSE, and `waitForPort` (`run.ts:276-297`) then **succeeds against the OTHER shard's `serve`**. Both use the same token, `"e2e-token"` (`run.ts:442`, `:522`). Result: silent cross-talk. Design: wait on the port **and** on the child still being alive (`waitForServe`, below). |
| Mock model, relay, fake APNs, probes, hooks | `port: 0` everywhere (`mock-model.ts:378`, `run.ts:411`, `run.ts:1111`, `escape-probes.ts:37`, `hooks.ts:441`), and each is in-process | Not shared (per process) |
| Config dir / workspace | `TENTACLE_CONFIG_DIR = <runDir>/config` (`run.ts:463`), `serve` cwd = `runDir` (`run.ts:460`) | Not shared (per run dir) |
| Phone → daemon | The app dials `ws://127.0.0.1:<daemonPort>/e2e` from its own pairing (`run.ts:493`, `:501-507`). Simulators share the host loopback, but each phone only knows its own shard's port | Not shared |
| Simulator state | `--device <udid>` (`run.ts:1768-1770`); `terminate`, `keychain reset` (`:843-848`), `uninstall/install` (`:807-811`), `addmedia` (`:1070`), Face ID (`:1820-1823`) and appearance (`:759`) are all per udid | Not shared |
| Module globals | `children`, `notifyKeysCache`, `lastSealed` (`run.ts:59`, `:1166`, `:1169`) | Per process |
| Push payload file | `RUNS_DIR/push-payload-${Date.now()}.json` (`run.ts:1379`) | **Shared dir.** A same-ms collision lets one process `rm` the other's file (`:1394`). Only quarantined flows reach it today, but it is fixed anyway: add `process.pid` to the name. |
| Swift tests | `bun run test:swift` → `cd apps/mobile/native-tests/PushCoreTests && swift test` (`run.ts:353-361`, `package.json:28`) | **Shared** SwiftPM `.build` lock. Design: the parent runs it once; children skip it. |
| Build | `expo prebuild` writes `apps/mobile/ios/` (`run.ts:997-1005`); `expo run:ios` builds into the GLOBAL `~/Library/Developer/Xcode/DerivedData/tentacle-<hash>/…/Release-iphonesimulator/tentacle.app`. Evidence: `build-ios26.log:3546` of run `1795363693570` shows `› Installing /Users/…/DerivedData/tentacle-birlitcuhrfjpefpumnmkaoctsns/Build/Products/Release-iphonesimulator/tentacle.app` | **Shared.** Design: children NEVER build; they always get `--app`. |
| Maestro debug output | Maestro writes its own debug dir under `~/.maestro/tests/<timestamp>/` (outside our `--test-output-dir`) | Possibly the same dir for two processes starting in the same second. Harmless: the verdict reads only the exit code (`run.ts:1812`) and `junit.xml` goes to `outDir` (`:1791-1793`) |
| **Maestro's XCTest driver port** | Simulators share the host network. If Maestro 2.12.1 (`/opt/homebrew/Cellar/maestro/2.12.1`) binds one fixed host port for every iOS simulator's driver, two concurrent `maestro --device X test` processes collide | **UNPROVED.** In this session I could not run `maestro test --help` or read its jar (permission denied), and no past run dirs overlap in time (`17953[6-7]*` holds only the gate's own run). **Step 0 decides it.** |

**Step 0: the go/no-go experiment, run by the orchestrator before Execution.** In two terminals, started within ~1 s of each other, on the current code:

```sh
scripts/e2e-gate.sh 0FA4B51F-A0E3-421B-BE66-CE29EF45213D --only 33-hub,27-activity
scripts/e2e-gate.sh 0B43D716-9670-421A-BE51-9162004F2963 --only 38-running-row,36-theme-beta-shots
```

These are four long flows (237/167/213/185 s in the last gate), so the flows overlap for minutes. The second terminal reuses the first one's `.app` via `--app <DerivedData path printed by the first build>`, or both build in sequence first. Both must end `GATE PASS`, with no `DeviceUnreachable`/`Connection refused` in any `maestro.log`. A helper that lists overlapping attempts of past runs is in `.tentacle/tmp/e2e-parallel-gate/overlap.ts` (`bun` it; I was not permitted to run it).
- **Pass:** proceed as planned.
- **Fail with a driver-port error:** STOP and amend this plan. If `maestro test --help` lists a per-run driver port option (e.g. `--driver-host-port`), the design passes a distinct port per child (one more `spawnFlow` argument). Otherwise the parallel form is not buildable on this Maestro: escalate to the owner. Do not work around it with retries.

### Preconditions (verified)

- **P1. Each flow is order-independent apart from shared seeded sessions.** Every flow relaunches with `clearState` + `clearKeychain` (`_pair`), and the harness resets the keychain and terminates the app before every attempt (`run.ts:843-848`). The 13d/hub flows get a session created just before they run (`COMPOSE_SESSION_VARS`, `run.ts:1576-1618`; `spawnFlow` `:1758-1765`). The state that DOES carry across flows lives daemon-side in the sessions seeded once per `serve` (`run.ts:523-527`) and passed as `ALPHA_ID, BRAVO_ID, CHARLIE_ID, ASK1_ID…ASK5_ID` (`run.ts:1775-1785`). Who uses them (grep of `flows/*.yaml` + `flows/*.js`):
  - **ALPHA**: `02, 05, 06, 07, 11, 17-persisted, 22-relay-only, 26-drawer`. 07 adds a turn to it and 26 renames it (`26-drawer.yaml:46-76`).
  - **BRAVO/CHARLIE**: `02`, and `06` (CHARLIE).
  - **ASK1**: `08` and the quarantined `22-notify-*`. **ASK2–5**: `08b, 08c, 09, 10`, one each.
  - Therefore **every flow that shares a seeded variable must run on the SAME shard, in `FLOWS` order**. Each shard has its own `serve` and its own seed, so it then sees exactly the subsequence of mutations to that session that it sees today.
- **P2. The "LAST" rules are about ordering within one daemon, not cross-flow state.** `FLOWS` comments `run.ts:1515-1533` (lock flows, `22-relay-only`, `push-placeholder`). Keeping each shard's flows in `FLOWS` order preserves them per shard.
- **P3. Flow durations are already recorded.** Every run writes `<runDir>/summary.json`, a `FlowResult[]` with `seconds` (wall time of all attempts) per flow (`run.ts:886-893`, `:910`; type `gate.ts` `FlowResult`). Quarantined flows have `seconds: 0` (`run.ts:820-826`). Last gate: sum 4221 s; ALPHA group 482 s; largest single flow `33-hub` 237 s. A 2-way split can therefore be balanced to within one flow.
- **P4. `--app` installs a ready build** with a clean uninstall first (`run.ts:807-811`). `--only` wins over `E2E_ONLY_FLOWS` (`run.ts:1550-1567`). `scripts/e2e-gate.sh` passes its first argument verbatim as `--udid` (`scripts/e2e-gate.sh:20`), so `a,b` reaches `run.ts` unchanged and the shell script needs no logic change.
- **P5. The verdict and the summary are pure** (`gate.ts` `verdictOf`, `summaryText`). A merged `FlowResult[]` gets the same table, counts and exit code.
- **P6. The orchestration launchers** (`.tentacle/tmp/orchestration/run-gate-build-2211*.sh`, gitignored, NOT in this diff) grep `^✗` and take `awk '{print $2}'` as the flow name, then rerun those single-sim. Relayed child lines must keep `✗` at column 0 and the flow name as the second field.
- **P7. Run-dir consumer:** `scripts/mockup-kit/calibrate.ts:43-59` takes the newest dir under `.tentacle/tmp/e2e-mobile/` and looks for shots at `<run>/ios*/<flow>/`. Two consequences: the app cache must NOT live under `e2e-mobile/`, and `shotPath` must also search `<run>/sim-*/ios*/`.

### Design

**D1. Opt-in form.** A comma-separated UDID list: `scripts/e2e-gate.sh <udidA>,<udidB> [flags]` (or `--udid a,b`, or `E2E_SIM_UDID=a,b`). `parseUdids` returns 1..N distinct UDIDs; a duplicate or an empty item → exit 2. One UDID → the existing path in `main()`, byte-for-byte the same apart from D6/D7. Two or more → `run.ts main()`, right after the meta check (`run.ts:305-310`), returns `(await import("./parallel.ts")).runParallel(...)`. That is a dynamic import, like `seed.ts` at `:510`, so there is no import cycle. `--hold` combined with several UDIDs → exit 2 (a hold on two sims has no meaning).

**D2. Parent (`parallel.ts`, effectful).**
1. **Prerequisites once.** Run `deviceChoice` (`gate.ts`) on every UDID; any `unknown` → print it and exit 2. Run `preflight(..., ...majorsOfAllUdids)`, with the same probes as `run.ts:312-322`: `versionOf`, `simctlRuntimes` and `simctlDevices` become `export`ed, unchanged. Then `test:swift` once (`run.ts:353-361`, moved into an exported `runSwiftTests()` that both paths call).
2. **Parent run dir** `RUNS_DIR/<runId>/`, with `parent.json` = `{runId, udids, shards: {label, udid, flows}[], appSource, appKey}`.
3. **App once** (D6). Boot + bootstatus device A (the same two commands as `run.ts:789-790`), then `resolveApp` with device A. A build failure → exit with that code (as `run.ts:812-815`).
4. **Split** (D3). Quarantined flows are NOT sent to any child: the parent makes their results itself, the same shape as `run.ts:820-826`. If a shard ends up with no flows (e.g. `--only x` on two sims), no child is spawned for it.
5. **Children.** For each non-empty shard: `bun run.ts --udid <u> --app <app> --only <flows,…> --shard-of <parentRunDir> [--flow-timeout N]`. Only `--flow-timeout` is forwarded; `--ios` was already validated. Children are spawned concurrently, `stdout`/`stderr: "pipe"`. Each stream is read line by line: the line is appended to `<parentRunDir>/<label>.log` and printed as `<line>  [<label>]`, with the label as a SUFFIX so `^✗` and `$2` still work (P6). `label = sim-<first 8 chars of udid>`.
6. **Signals.** On SIGINT/SIGTERM the parent sends SIGTERM to every child. A child's own `installSignalReap` (`run.ts:1715-1733`) reaps its Maestro group and exits 143. The parent waits for them, then exits 130/143.
7. **Merge** (D4). Read `<parentRunDir>/<label>/summary.json` for each child. Write the merged `summary.txt` + `summary.json` into the parent run dir. Print `summaryText(merged)`, then one extra line `wall <s> s on <n> simulators (shards: A <s> s, B <s> s)`, then `results in <dir>`. Exit with `parallelExitCode` (D4).

**D3. Split (pure, `shard.ts`).**
- `flowGroups(runnable, textOf)`: union-find over the shared seed variables `SHARED_SEED_VARS = ["ALPHA_ID","BRAVO_ID","CHARLIE_ID","ASK1_ID",…,"ASK5_ID"]`. This constant mirrors `run.ts:1775-1785`, and `spawnFlow` is changed to build its `-e` list FROM this constant, so the two cannot drift. Two flows are in one group when both texts contain `${VAR}` or a bare `VAR` (the `.js` scripts read it bare, e.g. `07-history.js:7`). `textOf(flow)` is the effectful gatherer in `parallel.ts`: the flow's yaml plus, recursively (with a visited set), every `flows/<name>.js|.yaml` it names (`runFlow: _pair.yaml`, `file: "09-laptop-hold.js"`, see `09-foreign-turn.yaml:12,30`).
- `latestDurations(summaries)`: input `{runId: number, results: FlowResult[]}[]`. Newest run first, the first non-quarantined `seconds` per flow wins. The gatherer reads `RUNS_DIR/*/summary.json`, one level only: that is single runs and parallel parents' merged summaries, and never a child's, so nothing is counted twice. A missing or unreadable file is skipped.
- `splitShards(groups, durations, n, order)`: a flow with no record costs the median of the known ones (none known → `DEFAULT_FLOW_SECONDS = 60`). Groups are taken in descending total cost (tie → earliest `FLOWS` index), each into the currently lightest shard (tie → lowest index). Each shard is then re-sorted by `FLOWS` index. It is deterministic: same inputs → same split.

**D4. Merge (pure, `shard.ts`).**
- `mergeShardResults({order, quarantined, shards: {label, dir, flows, results | undefined}[]})`:
  - Concatenate, then sort by `order` (`FLOWS` order), so the merged table lines up row-for-row with a single-sim summary.
  - Every flow the parent sent must appear **exactly once**. A flow missing from its shard's results (the child crashed or exited 2 before writing a summary) → a `{status: "fail", seconds: 0, attempts: 0, outDir: <shard dir>}` result. A flow that never ran is counted RED, never skipped: the gate does not get weaker.
  - A flow present twice, or one the parent never sent → throw. The parent prints it and exits 1.
- `parallelExitCode(childCodes, verdict)`: the first child code not in {0,1} wins: 2 = prerequisite, other = build/install, the same meanings as single (`scripts/e2e-gate.sh:8-10`). Otherwise `verdict.exitCode`. A child killed by a signal (`exitCode === null`) maps to 1.

**D5. Child mode `--shard-of <dir>`** (`run.ts parseArgs`, `run.ts:68-136`). It requires `--app` and a single `--udid`; otherwise parse error → exit 2. It changes exactly three things:
- `runDir = <dir>/sim-<udid8>` instead of `RUNS_DIR/<runId>` (`run.ts:363-364`).
- It skips `test:swift` (the parent ran it).
- It writes no app cache (it never builds).

Everything else is the single path: boot, Face ID, addmedia, clean install, flows, `summary.json`. The child also logs `e2e:mobile shard of <dir>`.

**D6. One build, reused (`resolveApp`, effectful, in `run.ts` next to `buildAndInstall`; both paths use it).**
- `--app X` → install X (today's behaviour).
- Otherwise compute `key = appCacheKey(inputs)` (pure, `shard.ts`) and look in `CACHE_DIR = <main repo>/.tentacle/tmp/e2e-app-cache/<key>/tentacle.app`. The main repo is `dirname(git rev-parse --path-format=absolute --git-common-dir)`, so worktrees and the root share one cache. Content keys make that honest. The cache is outside `e2e-mobile/` (P7).
  - **Hit**, and `Info.plist` exists inside it → `simctl install` it, and log `app: cached <key12> (built in run <runId>)`.
  - **Miss** → `buildAndInstall` as today (`run.ts:989-1033`), then `builtAppPath(buildLog)` (pure: the last `› Installing (.+\.app)$` line). Copy the app with `fs.cp` recursive into `<CACHE_DIR>/<key>.tmp-<pid>/`, write `meta.json` `{key, runId, builtAt, inputsCount}`, then `rename` to `<key>`. If the target already exists (a concurrent builder) → remove the tmp dir. If the path is not found in the log → the build is still installed (the run proceeds), with a warning `app not cached: no install path in build log`; a cache failure never fails a gate.
  - **Eviction**: after a store, keep the 3 newest `<key>` dirs by mtime (pure `cacheEvictions(entries, keep)`). An app is ~100–200 MB.
  - `--no-app-cache` / `E2E_NO_APP_CACHE=1` forces a build and does not read the cache. It still stores the result.
- **Key inputs (honest, over-inclusive):**
  - Every file from `git ls-files -co --exclude-standard -- apps/mobile packages package.json bun.lock patches`, minus the prefixes `apps/mobile/e2e/`, `apps/mobile/test/`, and `packages/*/test/` (the harness, flows and unit tests are never imported by the bundle), hashed as `sha256(path NUL content)`. A tracked file deleted from the worktree hashes as `path NUL <deleted>`.
  - Plus the extras `xcodebuild -version`, `process.versions.bun`, `"Release"`, `KEY_SCHEMA = "e2e-app-v1"`.
  - Sorted by path before hashing, so the key does not depend on order.
  - `apps/mobile/native-tests/` is deliberately NOT excluded (`targets/live-activity/LACore/LACore.swift:24` shares code with it). `apps/mobile/ios/` is gitignored (`.gitignore:33`) and regenerated from `app.json` + plugins, which are themselves keyed.
  - The JS change → Release bundle case is covered because all of `apps/mobile/src` and `packages/*/src` are inputs.

**D7. Hardening needed by parallelism (single path too, behaviour-neutral when nothing races).**
- `waitForServe(child, port)`: `Promise.race(waitForPort(port), child.exited.then(code => throw "serve exited (code) before listening on port — port taken?"))`. It replaces the 5 `waitForPort` calls that follow a `startServe` (`run.ts:489`, `:565`, `:574`, `:602`, `:860`). The probe at `:592` stays a plain `waitForPort`, because it checks that serve is DOWN.
- `placeOnSimulator` file name `push-payload-${process.pid}-${Date.now()}.json` (`run.ts:1379`).

**D8. Single-sim form unchanged.** Same CLI, output, summary location (`RUNS_DIR/<runId>/`), exit codes and quarantine/known-bug semantics. The only visible differences: one `app: …` log line, and a cache hit skips `prebuild`/`xcodebuild` (owner goal: "a task's `--only` shots … do not each rebuild"). No new retries anywhere: `shouldRetry` (`gate.ts`) is untouched, and `DeviceUnreachable` stays a red unless the flow is `flaky`.

### Files (dependency order, smallest diff)

1. `apps/mobile/e2e/shard.ts` — **new, pure**: `SHARED_SEED_VARS`, `parseUdids`, `flowGroups`, `latestDurations`, `splitShards`, `mergeShardResults`, `parallelExitCode`, `builtAppPath`, `appCacheKey`, `cacheEvictions`, `DEFAULT_FLOW_SECONDS`, `relayLine(label, line)`.
2. `apps/mobile/e2e/run.ts`:
   - `parseArgs` gets `--shard-of` and `--no-app-cache`.
   - Export `versionOf`, `simctlRuntimes`, `simctlDevices`, `REPO`, `RUNS_DIR`, and new `runSwiftTests`.
   - `main()`: the parallel branch (D1), `runDir`/swift skip for `--shard-of` (D5), and `resolveApp` replacing `run.ts:807-811`'s install expression. The uninstall stays.
   - `resolveApp` + `appCacheInputs(repo)` (effectful: git + hashing).
   - `waitForServe` (D7) and the push file name (D7).
   - `spawnFlow`'s `-e` seed list built from `SHARED_SEED_VARS`.
3. `apps/mobile/e2e/parallel.ts` — **new, effectful**: `runParallel`, `flowText` gatherer, `readSummaries`, child spawn/relay/signal forwarding, merged summary write.
4. `scripts/e2e-gate.sh` — usage/comment only: document `<udid>[,<udid>…]`. Line 20 is unchanged.
5. `scripts/mockup-kit/calibrate.ts:53-59` — `shotPath` also searches `<run>/sim-*/ios*/`.
6. `apps/mobile/e2e/README.md` — "The gate" section: the parallel form, the app cache, `--no-app-cache`, the parent/child run-dir layout.
7. `apps/mobile/test/e2e-shard.test.ts` — **new**. Plus `apps/mobile/test/e2e-gate.test.ts`: `parseArgs` cases for `--shard-of` / `--no-app-cache`.

No protocol change and no `protocol.d/` note. Dev-only, so no `changelog.d/` fragment. The launchers (`.tentacle/tmp/orchestration/run-gate-build-*.sh`) are switched by the orchestrator after merge, outside the repo.

### Failure modes → how state converges

| Case | Behaviour |
|---|---|
| One UDID unknown/unavailable, or a duplicate | Parent exits 2 before any build (D2.1), with `deviceChoice`'s message. No child is spawned. |
| A simulator shut down / still booting | Each child runs `simctl boot` + `bootstatus -b` (`run.ts:789-790`), as today. The parent also boots A before the build. |
| One child crashes / exits 2 / is killed mid-run | The other child finishes. That shard's missing flows become `fail` rows pointing at its dir (D4), and the exit code is the child's non-0/1 code, or 1 (signal). The log is in `<parent>/<label>.log`. Never a silent green. |
| A flow times out | Unchanged: `runAttempt` kills its group (`run.ts:1637-1681`) → `TIMEOUT` row, counted. |
| `DeviceUnreachable` flake (more likely under two-sim load) | Unchanged semantics: red unless `flaky`. The launcher's existing rerun-the-red-ones-single-sim loop (P6) still works because `✗ <flow>` stays greppable. Step 0 / Validation show whether parallel load raises the rate. |
| Stale cached .app | Impossible by construction if the key is honest (D6). Tests pin that an app-source change changes the key, and that a harness-only change does not. A half-written cache entry cannot be read (atomic rename). An entry without `Info.plist` → treated as a miss and removed. `--no-app-cache` is the escape hatch. |
| Two runs (any worktrees) build the same key at once | Both build (into their own DerivedData). The first `rename` wins; the second discards its tmp. |
| Both halves writing the same file | Child run dirs are disjoint (D5). Child logs go to distinct `<label>.log` files written only by the parent. The merged summary is written only by the parent. The push file is pid-qualified (D7). The cache uses tmp+rename. `~/.maestro/tests` is cosmetic (audit). |
| `serve` port stolen by the other shard | `waitForServe` fails loudly: that flow (or the run setup) goes red with "serve exited before listening". It never seeds/pairs against the other shard's daemon (D7). |
| A shard gets 0 flows / all quarantined | No child for it. Quarantined rows come from the parent. |
| No duration history (fresh checkout) | Median → 60 s per flow. Balanced by count, still correct. |
| Ctrl+C on the parent | SIGTERM to the children → their reap kills the Maestro groups (D2.6). No orphaned driver. |

### Tests (red first, `bun test apps/mobile/test/e2e-shard.test.ts`)

For the pure parts, the executor writes each test against a stub that returns a wrong value (e.g. `splitShards` putting everything in shard 0), shows it RED, then implements it.
- **`flowGroups`**: 07 and 26 (both name `ALPHA_ID`) land in one group. 02 joins ALPHA through BRAVO/CHARLIE. 08b and 09 are separate. A bare `ASK4_ID` in a referenced `.js` text counts. A flow with no seeded var is a singleton. **Real-file test:** gather the real `FLOWS` texts and assert the ALPHA group is exactly `{02-session-list, 05-daemon-down, 06-session-open, 07-prompt, 11-disconnect-mid-turn, 17-persisted, 22-relay-only, 26-drawer}`. This is a canary: a new flow on ALPHA changes it on purpose.
- **`splitShards`**: deterministic; a group never split; each shard in `FLOWS` order; the max-min shard cost ≤ the largest group cost. With the last gate's durations (fixture copied from `summary.json` of run `1795363693570`), the two shard sums are within 237 s of each other. Unknown durations use the median.
- **`latestDurations`**: the newest run wins; quarantined zeros are ignored; an older run fills flows the newest lacks.
- **`mergeShardResults`**: output in `FLOWS` order; a crashed shard's flows become `fail` with its dir; a duplicate throws; quarantined rows are kept. Then `verdictOf(merged)` gives the same counts as the same results in one list.
- **`parallelExitCode`**: `[0,0]`+green→0; `[1,0]`→1; `[0,2]`→2; `[65,1]`→65; `[null,0]`→1.
- **`appCacheKey`**: order-independent; one byte changed in an `apps/mobile/src/…` input → a different key; adding an `apps/mobile/e2e/…` entry → the same key (exclusion applied INSIDE the pure function, given the raw list); a different Xcode string → a different key. **Real-repo test:** `appCacheInputs(REPO)` includes `apps/mobile/App.tsx` and a `packages/protocol/src/` file, and excludes `apps/mobile/e2e/run.ts`.
- **`builtAppPath`**: parses the real line (`build-ios26.log:3546`, copied as a fixture); `undefined` when absent; the last match wins.
- **`parseUdids`**: `"a"`→`[a]`; `"a,b"`→`[a,b]`; `"a,a"`/`"a,"`→error.
- **`relayLine`**: `✗ 07-prompt (iOS 26) fail` → starts with `✗`, `$2` is `07-prompt`.
- **`parseArgs`** (`e2e-gate.test.ts`): `--shard-of` without `--app` → throws; `--no-app-cache` parsed.
- **`waitForServe`**: a fake child whose `exited` resolves first → rejects with "serve exited". This one is effectful but injectable (child + port).
- **Mutation checks for Review:**
  - Drop the union step → the real-file ALPHA test goes red.
  - Drop the missing-flow → `fail` synthesis → the crashed-shard test goes red.
  - Remove `apps/mobile/src` from the inputs → the key-change test goes red.
- `parallel.ts`'s spawn/relay is checked live only (Validation). Its decisions are all in `shard.ts`.

Before done: `bun test` + `bun run typecheck` + `bun run lint` (baseline clean, AGENTS §6).

### Validation (the ORCHESTRATOR runs this live, after Execution)

0. Step 0 above already passed (no point validating otherwise).
1. **Baseline**: the last single-sim gate, `GATE PASS — 58 passed, 0 failed, 0 known-bug, 7 quarantined (of 65; 4221 s)`, run `1795363693570`, `.tentacle/tmp/orchestration/runs/e2e-gate-2211c.log:484`. Its wall time is the log's start→end (~70 min of flows + build).
2. **Cold parallel run** (empty cache): `time scripts/e2e-gate.sh 0FA4B51F-A0E3-421B-BE66-CE29EF45213D,0B43D716-9670-421A-BE51-9162004F2963 > …/e2e-gate-parallel-1.log 2>&1; echo $?`
   - Expect: exactly one `xcodebuild` (one `build-ios26.log` in the parent dir, none in `sim-*/`).
   - Both `sim-*` dirs have `summary.json`.
   - The merged summary has **65 rows, the same flow names in the same order** as run `1795363693570/summary.txt`, and the same verdict line counts (58/0/0/7, or a difference that is explained flow by flow).
   - Exit 0.
   - No flow name in both `sim-*` dirs.
   - `parent.json` shows the ALPHA group on one shard.
3. **Warm parallel run** (cache hit): the same command again. Expect the `app: cached <key>` line, no `xcodebuild`, and the same results. Record the **wall time** of both runs against the baseline. The target is ≈½ of the flow time; report the actual number and the per-shard sums from the `wall …` line.
4. **Single-sim unchanged**: `scripts/e2e-gate.sh <udid> --only 01-shell`. The old layout (`RUNS_DIR/<runId>/ios26/01-shell/`), exit 0, `app: cached` (the same key as step 3, because no app input changed). Then touch a comment in `apps/mobile/src/…` (uncommitted) → the same command shows a cache MISS and rebuilds. Revert the touch.
5. **Red propagation**: `scripts/e2e-gate.sh A,B --only 01-shell,07-prompt --flow-timeout 5`. Expect both `TIMEOUT`, exit 1, and `grep '^✗'` lists both flow names in field 2.
6. **Crash propagation**: during a two-sim `--only` run, `kill -9` one child `bun` (`pgrep -f 'shard-of'`). Expect that shard's flows reported `FAIL` pointing at its dir, a non-zero exit, and the other shard's results present.
7. Only then switch the launchers (`run-gate-build-*.sh`) to the `A,B` form. Their rerun loop stays single-sim.

## Execution

*— deepseek-chat, 2026-11-22*

As-built, in dependency order, with every drift from the Implementation named.

### Step 0 — the load-bearing check, re-run first (PASSED, with a caveat I caused)

The plan's one unproved item was whether two concurrent `maestro test` processes (2.12.1) on two
different simulators collide on a fixed XCTest-driver host port. Decided empirically in
`.tentacle/tmp/e2e-parallel-gate/step0/`: two `maestro --device … test` runs started together, one
per simulator, both `exit 0` with every step `COMPLETED`, and each process's driver listening on its
OWN ephemeral loopback port (`127.0.0.1:53051`, `127.0.0.1:53052`) — no clash, no
`DeviceUnreachable`. `STEP0.txt` holds the command, the ports and the verdict. **No per-run driver
port flag is needed.**

Caveat, stated plainly: `0B43D716…` was running ANOTHER gate's flow at that moment
(`run-gate-build-2211d.sh`, run `1795384590574`) and my probe shared that simulator. That gate's
`24-ui-shots` failed 93 s in with `maestro.DeviceUnreachableException: Device became unreachable
during screenshot` at 23:32:02 — inside my probe's window. The probe cannot be called the cause (the
exception is the suite's documented flake class, and the plan's own failure-mode table treats
`DeviceUnreachable` under load as `flaky`-only), but it cannot be excluded either: I should have
waited for the simulator to be free. Step 0 should be re-run on an idle machine during Validation; no
other finding below depends on the interfered run.

### Slice 1 — `apps/mobile/e2e/shard.ts` (new, pure)

`SEED_VAR_SOURCES` / `SHARED_SEED_VARS` (the map is the source of truth, so the splitter and
`spawnFlow`'s `-e` list cannot drift), `parseUdids`, `flowGroups` (union-find over the seeded vars,
with a `textOf` gatherer supplied by the caller), `latestDurations`, `splitShards` (LPT greedy over
GROUPS, ties by `FLOWS` index), `mergeShardResults`, `parallelExitCode`, `builtAppPath`,
`appCacheKey`, `isHarnessOrTest`, `cacheEvictions`, `relayLine`, `shardLabel`, `seedValues`,
`DELETED`, `DEFAULT_FLOW_SECONDS`, `KEY_SCHEMA`.

Written as stubs first (37 of 47 tests red), then implemented. Two of the six remaining reds were
real semantics, not test typos:

- `parallelExitCode([1, 0], green verdict)` returned **0** — a child's own red washed out by a green
  merge. Fixed: a child code of `1` (or `null`) keeps the gate red unless the verdict is red too;
  only a `2+` code short-circuits earlier. A genuine hole the plan did not name.
- `cacheEvictions`' returned order (cosmetic).

**Drift from the plan (test strength).** The plan's real-file ALPHA canary does NOT catch a dropped
union step: every flow in `{02,05,06,07,11,17,22,26}` mentions `ALPHA_ID` directly, so the union is
only load-bearing for a flow that reaches a seeded session through a SECOND variable. Measured, not
assumed (M1 reddened only the synthetic bridge test). Added `flowGroups > the REAL flows: a
CHARLIE-only flow joins ALPHA's group through 06's bridge`, which pins the real property.

**Drift (`seedValues` instead of a bare constant).** The plan said `spawnFlow` builds its `-e` list
from `SHARED_SEED_VARS`. Done through `SEED_VAR_SOURCES` + `seedValues(seeded)`: an index-arithmetic
version was written first and rejected as fragile (an off-by-one on `askIds` would silently pass an
empty id).

### Slice 2 — `apps/mobile/e2e/run.ts`

- `parseArgs`: `--shard-of` (requires `--app` and exactly one `--udid`) and `--no-app-cache`.
- `versionOf`, `simctlRuntimes`, `simctlDevices` exported; `runSwiftTests()` extracted (both paths
  call it).
- `main()`: the parallel branch right after the tag check — `parseUdids`, `--hold` refused with
  several UDIDs, `runParallel(udids, options)` dynamically imported (no cycle). `--shard-of` changes
  exactly three things: `runDir = <parent>/sim-<udid8>`, no `test:swift`, no app cache.
- `resolveApp` + `appCacheInputs`: `--app` verbatim → cached hit (`Info.plist` present) → build, then
  store via `fs.cp` into `<key>.tmp-<pid>` + `rename`; a cache failure only warns; 3 newest kept.
- `waitForServe` (D7) replacing the five `waitForPort` calls that follow a `startServe`; the probe
  that checks serve is DOWN stays a plain `waitForPort`. The push payload file name is pid-qualified.

**Drift (good one).** The shard's dir name is `shardLabel(udid)` — the SAME function the parent uses
to read the child's summary, not the plan's inline `sim-${udid.slice(0,8)}`. Two copies of that slice
would drift on a non-standard UDID and the merge would read nothing.

**Drift (`versionOf`).** `.env(env ?? process.env)` did not typecheck under `strict` once the function
was exported (a `ProcessEnv` index is `string | undefined`); it now materializes a
`Record<string, string>`. Behaviour identical.

**Drift (`appCacheInputs`).** It now applies `isHarnessOrTest` itself (963 inputs instead of 2359),
not only in `appCacheKey`. The plan's pure requirement — "exclusion applied INSIDE the pure function,
given the raw list" — still holds, and `appCacheKey` still filters, so the key is unchanged; this only
stops the gate reading ~1400 files it would discard.

### Slice 3 — `apps/mobile/e2e/parallel.ts` (new, effectful)

`runParallel(udids, options)`: validate every device before any build, run `test:swift` once, boot
device A, resolve the app ONCE, split, spawn the children concurrently with per-shard logs and
relayed lines, merge, write `summary.txt`/`summary.json`/`parent.json`, print the `wall …` line,
return `parallelExitCode`. `flowText` is the recursive gatherer (`runFlow:` and `file:`, with a
visited set); `readHistory` reads one level under the runs dir (single runs and parallel PARENTS,
never a child's).

**Drift.** The plan's `ParallelDeps` indirection (an injected bag of callbacks) is gone: `parallel.ts`
imports the effectful helpers from `run.ts` directly (it is loaded dynamically FROM `run.ts`, so
there is no cycle). A second, hand-maintained interface to keep in sync was ceremony — the decisions
it was meant to isolate all live in `shard.ts`, where they are unit-tested.

**Drift.** A quarantined row's tags come from the parent's own `metas`; `mergeShardResults` takes a
`tagsOf` callback so a synthesized red keeps a `known-bug`/`flaky` tag and is not miscounted.

### Slice 4 — the docs and the consumers

- `scripts/e2e-gate.sh`: usage/comment only (`<udid>[,<udid>…]`, the parallel form, the cache,
  `--no-app-cache`); the `exec bun … --udid "$udid"` line is unchanged.
- `scripts/mockup-kit/calibrate.ts`: `shotPath` also searches `<run>/sim-*/ios*/`.
- `apps/mobile/e2e/README.md`: a "Two simulators at once" section + the app cache.

### Slice 5 — tests

`apps/mobile/test/e2e-shard.test.ts` (new, 52 tests) and `apps/mobile/test/e2e-gate.test.ts`
(+`--shard-of`, `--no-app-cache`, and two `waitForServe` cases). Fixture:
`apps/mobile/test/fixtures/e2e-summary-1795363693570.json` (the real last gate's 65 rows).

Red first: stubs → 37 fail / 10 pass; then 6 fail → 0. `waitForServe` and the two `parseArgs` cases
were green-on-new by construction (that code already existed), so they are covered by
mutation-instead (M4–M6).

### Mutation checks (all six bite)

| # | Mutation | Reddened |
|---|---|---|
| M1 | drop the union step in `flowGroups` | the synthetic bridge test + the REAL-flows bridge test (48 pass, 2 fail) |
| M2 | drop the missing-flow → `fail` synthesis | 2 `mergeShardResults` tests (48 pass, 2 fail) |
| M3 | widen the key's exclusion to all of `apps/mobile/` | 3 `appCacheKey` tests (47 pass, 3 fail) |
| M4 | `appCacheInputs` stops excluding the harness | the REAL-repo app-input test (50 pass, 1 fail) |
| M5 | the key sees a file's path but not its content | 2 `appCacheKey` tests (49 pass, 2 fail) |
| M6 | `waitForServe` degenerates to a bare `waitForPort` | the "serve exits before listening" test (40 pass, 1 fail) |

### Real-data check (no simulators — the live runs are Validation's)

Over the real repo and the real duration history:

```
history runs: 10 newest: 1795363693570
flows with a duration: 58
ALPHA group via parallel.flowText: ["02-session-list","05-daemon-down","17-persisted",
  "06-session-open","07-prompt","11-disconnect-mid-turn","26-drawer","22-relay-only"]
split sizes: [35, 33]  seconds: [2222, 1999]
group never split: true
```

2222 s vs 1999 s — a 223 s difference, inside the plan's "within 237 s" bound (the largest single
flow, `33-hub`). ALPHA is exactly the plan's predicted set and is never split.

### Changelog (drift from the plan)

The plan said "dev-only, so no `changelog.d/` fragment". The task's instructions require one, and the
parallel form is visible to anyone running the gate, so `changelog.d/e2e-parallel-gate.added.md` was
written (one bullet; `CHANGELOG.md` untouched).

### Not done here (Validation's; stated as unverified)

- No live two-simulator run, no cache hit/miss, no single-sim regression: `0B43D716…` was still busy
  with `run-gate-build-2211d.sh` throughout Execution, and the plan assigns these to the orchestrator.
  `parallel.ts`'s spawn/relay/signal code is therefore **verified only by typecheck and reading**, as
  the plan anticipated ("checked live only").
- `scripts/mockup-kit/calibrate.ts`'s new `sim-*` branch is exercised only by real artefacts; no test
  covers it.

Gate status: `tsc --noEmit -p apps/mobile` clean; `biome check` clean on all 6 changed files;
`bun test apps/mobile/test/e2e-shard.test.ts apps/mobile/test/e2e-gate.test.ts` → 90 pass, 0 fail. The
whole-repo gate is the orchestrator's.

## Review

*— claude-opus-5-5, 2026-11-22* (fresh context; same model family as the planner, different from the executor)

**Verdict: REQUEST-CHANGES**

1. **HIGH — the app cache key ignores binary bytes.** `run.ts` `appCacheInputs` reads every input with `readFile(…, "utf8")`; invalid UTF-8 decodes to U+FFFD, so two different binaries (fonts under `apps/mobile/assets/fonts/*.ttf`, PNGs) hash the same. Repro `.tentacle/tmp/e2e-parallel-gate/review-utf8.ts`: `[89 50 FF 00]` vs `[89 50 FE 00]` → `keys equal: true`. Effect: an asset change reuses a stale cached `.app` and the gate passes on the old build. That falsifies the plan's "Stale cached .app — impossible by construction". Fix: hash the raw `Buffer` (`AppInput.content: Uint8Array | DELETED`), and add a test with two byte arrays that differ only in invalid-UTF-8 bytes.
2. **MEDIUM — the relay splits lines on chunk boundaries.** `parallel.ts` `runChildren` `relay` splits each `data` chunk on `\n` and prints every fragment as its own line. A line cut across two pipe reads (coalesced Maestro output >64 KB, or a multi-byte `✗` cut in half) gets printed as two lines. `✗ 07-pr  [sim-…]` then gives the launchers' `awk '$2'` (P6) the wrong flow name, or none. Fix: keep a remainder buffer per stream and decode with `setEncoding("utf8")`/`StringDecoder`.
3. **MEDIUM — undocumented drift: the parent skips `preflight`.** D2.1 says the parent runs `preflight(…, majors)` before the build. `runParallel` checks only `deviceChoice` and then builds. A missing Maestro/CocoaPods/runtime therefore shows up as a build failure (exit ≠2), or as an exit 2 from both children after a 10–15 min build, not as exit 2 within a second. The behaviour is loud, not silent, but it breaks D2.1 and the exit-code table. Fix: run the same preflight in the parent, or record the drift.

Gate: `bun test apps/mobile/test/e2e-shard.test.ts apps/mobile/test/e2e-gate.test.ts` → 92 pass / 0 fail. `bun run lint` clean (2278 files). `bun run typecheck` clean. The full `bun test` was not run by me.
Mutation: I made `parallelExitCode`'s child-red step dead → 2 tests failed (49 pass) → reverted, `git status` clean. The executor's M1–M6 were not re-run.
Attacks tried: binary key collision (found #1); relay framing against the P6 grep contract (found #2); exit-code/prerequisite path vs D2.1 (found #3); child `runId` reuse (the parent dir name only labels `endpoint.json`/`meta.json`, harmless); `shardLabel` collision (needs two UDIDs with the same first 8 hex chars, negligible); merge synthesis and duplicate throw (both hold, tests pin them); single-sim path (unchanged apart from `resolveApp`/`waitForServe`, as D8 says).
Holds: the D4 merge never turns a missing flow into a silent pass; the seed-var map is one source shared by `spawnFlow` and the splitter; `--shard-of` validation; `waitForServe`. No §7 runtime invariant is touched (test infrastructure only).
Executor behaviour: honest Execution, with its drifts named (apart from #3) and the Step 0 interference disclosed. Live spawn/relay/signal behaviour is still unverified (Validation's job).
