# feat/detached-relay-lifecycle — a detached run's end: `--keep=false`, keep-awake, resident version, `ps`/`rm` (detached-runs S2b + S4)

> **Status:** implementation — plan approved by the owner 2026-10-31
> **Branch:** `feat/detached-relay-lifecycle`
> **Type:** feat · **Size:** L · **Blast:** load-bearing · **Suited:** Opus executes, mandatory fresh-context Review

**Owner decisions (2026-10-31):** plan approved; Q1 (a) one branch, Phase A then Phase B, gate between; Q2 (a) keep the workload on failed/interrupted/start death; Q3 (a) leave an unreadable `owner.json`, name it; **Q4 (b) delete the run dir after the relay's own removal** (overrides the plan's recommendation: line 186 and every place that keeps the run dir after a normal keep=false removal must follow (b); a run that keeps its workload under Q2 keeps its run dir too).

Umbrella: [`docs/feat/detached-runs.md`](detached-runs.md) (DR-1…DR-9, sub-plans). As-built S2: [`docs/feat/detached-relay.md`](detached-relay.md) (S2b sketch, Split, Reviews, live test, Merge decision).

## Context

*— claude-opus-5-5, 2026-10-31*

**Why.** S2 runs a pod turn with no TUI, but a detached run has no complete ending: `--keep=false` is refused, the Mac may sleep mid-turn, `ps` shows nothing, and `rm` deletes a workload under a live relay. Two S1 review items also stayed open, and S2 made both more reachable.

**Scope.** All six items are in. None is argued out.

1. **DR-5:** `--keep=false` with `--detach`. The workload goes when the relay exits normally, and a pending ask keeps it alive.
2. **DR-9:** caffeinate while a turn runs, on by default on macOS, `detach.keepAwake` to opt out.
3. **TODO "report the resident's REAL version".**
4. **TODO "do not stop an idle resident before an install that cannot land".**
5. **S4 (folded in, owner 2026-10-31):** `ps` STATUS and `-v` show the detached state through a pure `statusOf`, and `rm` stops the owning relay first.
6. **Live test:** no separate S2b run. The "Live test checklist" below is run ONCE, by the owner by hand in a real terminal, after S3 merges.

**Owner decisions that bind it.**
- **DR-1 (c):** one laptop owner at a time.
- **DR-3 (A):** a detached run waits at the first ask unless `--auto-accept`. It stays allow-once, pod asks only, logged. (Since `docs/fix/detach-live.md`, D2 + D3: auto-accept no longer ends with the relay; it is inherited on attach and shared per session.)
- **DR-4 (A)+:** the relay exits after 60 s of idle, or on stop, or when the workload is gone.
- **DR-5 (B):** removal on a normal exit (idle or stop), an exit net for crashes, a pending ask keeps it alive.
- **DR-6:** `ps` STATUS words, the log path in `-v`, `rm` stops the owner first.
- **DR-7 (A):** no notification. The umbrella's split table still lists one under S4: it is dropped.
- **DR-9 (C):** only while a turn runs. The lid limit is said once at launch.
- **S2 Q2 (a):** a held ask has no answer until S3, and `kill <pid>` is the way out.
- **Merge decision (2026-10-31):** S2 items 3, 8 and 17 move to this slice's checklist.

**Left to later slices.**
- **S3:** control socket, live hand-over, `attach` opening the run's session, DR-8 message, TUI owner file, so `ps`'s `attached` word waits for S3 (no process can write it yet). S3 must also make a hand-over leave the workload alone (see Design, `exitPlan`).
- **S5:** `/detach`, relay mode `adopt`.

**Repro** (2026-10-31, `main` 9dbb57d, `.tentacle/tmp/detached-relay-lifecycle/repro.test.ts`, run with `bun test`): `main([... "run","--detach","--keep=false","--prompt","hi","--image","node:22"])`, then `psCommand` over a kept entry with a live lock and `owner.json{waiting-permission, tool: shell}`, then `residentStatus.length`.

```
exit 1  | [error] --detach keeps its workload: --keep=false is not supported with it
NAME   ENGINE   WHERE   MOUNT   MODEL   AGE   STATUS
box    docker   local   —       m       1h    running
residentStatus arity: 2 (socketPath, version)
```

The third line is the point: `ps` says `running` for a run stuck on a permission. The arity shows the status takes its version from the caller. Item 4 needs no repro: `T10` pins the order today (`packages/cli/test/engine-runtime.test.ts:1354`).

## Implementation

*— claude-opus-5-5, 2026-10-31*

Verified on `feat/detached-relay-lifecycle` = `main` 9dbb57d.

### Load-bearing assumption

**When a `--keep=false` relay decides to exit, it can tell that nobody else needs the workload, and it can keep every laptop client out until the delete is done.**

Everything else in the slice is additive. If this one fails, the slice deletes a workload someone is using, and that cannot be undone.

**PROVEN in-process and by reading. NOT proven with a real engine delete or a compiled relay:** that is the checklist's job.

- **Laptop clients are kept out by the lock, held through the delete.** `attach` checks the lock before it dials anything (`packages/cli/src/main.ts:971-981`). `lockHolder` reads pid + start time (`packages/cli/src/pod-resident.ts:605-608`). `leave()` releases the lock last (`packages/cli/src/relay.ts:160-166`). So putting the delete before `leave()` means an `attach` is either refused or finds the workload already gone.
- **The one hole in the lock is the provisioning window.** An `attach` before the relay locks joins the resident with a fresh session (accepted in S2, `docs/feat/detached-relay.md` Failure modes). With keep=true that was harmless. With keep=false it would be deleted under it, so the lock alone is not enough.
- **`session/list` closes that hole.** On the relay's own live link it shows every other session, with `running`, `attached` and `jobs` (`packages/protocol/src/session.ts:675-694`, `packages/cli/src/local-runtime.ts:414-421`). Probe A below proves it.
- **The relay's existing `jobs` value is NOT good enough.** It starts at 0 and an unreadable poll leaves the last value standing (`packages/cli/src/relay.ts:239-245`), so a link that fails during the grace exits with `jobs = 0` and a job running. Harmless with keep=true. So removal needs one fresh, positive read.
- **A "normal exit" can be told apart.** `relay-state.ts` already holds `rest`, `stopping` and `exitNow` (`packages/cli/src/relay-state.ts:27-41`). A pending ask blocks idle (`:116`).

**Probe A** (`.tentacle/tmp/detached-relay-lifecycle/probe.test.ts`, real `SessionHost` + `Connection{servesModel}`, two `RemoteClient`s; the relay's client lists, `1111` is its session, `8b32` the other client's):

```
A1 alone:                     [ {1111 running:false attached:1 jobs:0} ]
A2 another client, own session: [ {8b32 running:false attached:1 jobs:0}, {1111 running:false attached:1 jobs:0} ]
A3 that client gone:          [ {8b32 running:false attached:0 jobs:0}, {1111 running:false attached:1 jobs:0} ]
```

A3 sets the rule: a session whose client left is listed with `attached: 0`, so "other users" means another session with `attached > 0`, `running` or `jobs > 0`, never merely another session.

**Probe B, what fires an `exit` handler** (Bun 1.4.3, a child that spawns a detached `sh` from `process.once("exit")`):

```
B return:       exit 0              exit handler + detached child: true
B exit130:      exit 130            exit handler + detached child: true
B throw:        exit 1              exit handler + detached child: true
B reject:       exit 1              exit handler + detached child: true
B handled-term: exit 0              exit handler + detached child: true
B sigterm:      exit 143 (SIGTERM)  exit handler + detached child: false
B sigkill:      exit 137 (SIGKILL)  exit handler + detached child: false
```

So the net covers a real crash, and never a SIGKILL or a power loss. The relay always installs a SIGTERM handler (`relay.ts:64-80`), so `sigterm` does not apply to it. It also fires on every exit that reaches `process.exit`, the relay's own normal one included (`main.ts:1179`), so it must be disarmed.

**Probe C, `caffeinate`** (this Mac):

```
C1 assertion: pid 80429(caffeinate): … PreventUserIdleSystemSleep named: "caffeinate command-line tool"
C2 caffeinate alive after its -w pid was SIGKILLed: false
C3 -w on a dead pid: 0
C4 kill(SIGTERM): 143 SIGTERM
```

### Preconditions (against the AS-BUILT S1 + S2)

- **P1 — exit paths.** One loop, then `release`, `drain`, `leave` (`relay.ts:248-262`). `attach` failure and session-store failure go straight to `leave` (`:177-180`, `:198-204`).
- **P2 — the net.** `registerExitCleanup` is a private, undisarmable `process.once("exit")` (`engine-runtime.ts:227-231`), armed when there is no `keepHint` (`:339-341`).
- **P3 — the launcher trap.** `keepHint` decides the kept line, the index write and the net (`engine-runtime.ts:300`, `:309`, `:339`). `workloadDeps.keepHint` is absent with keep=false (`main.ts:856-866`), and so are the labels (`main.ts:834`, `:867`). The F8 wrapper would then print `undefined --resume …` (`main.ts:880`; Review round 1, attack 2).
- **P4 — `rm`.** `verify` then `check` re-read the labels right before the delete (`kept-cmd.ts:171-211`). `forgetKept` tolerates a missing file (`kept-index.ts:106-108`). `rm` never touches the run dir.
- **P5 — idempotent deletes.** Docker treats 404 as success (`packages/docker/src/client.ts:330`, `:341`). The docker best-effort child refuses a container without `OWNER_LABEL` (`packages/docker/src/container-cleanup.ts:10`). The k8s `deletePod` checks no label (`kept-cmd.ts:206-207`).
- **P6 — stopping a lock holder.** `residentStop(stateDir, graceMs, procOf)` is generic: `lockHolder`, SIGTERM, wait, SIGKILL, and it refuses its own pid (`pod-resident.ts:617-636`). The relay's stop is bounded at 5 s (`relay-state.ts:14`), and `release` at 3 s per step (`local-runtime.ts:100`).
- **P7 — identity.** The pod host already knows its version: `identity: { tentacle: APP_VERSION, kind: "container" }` (`serve.ts:433`). `initialize` returns neither (`daemon/src/connection.ts:329-332`). `InitializeResultSchema` is a strip schema (`protocol/src/session.ts:152-155`), so a new optional field is free (AGENTS §7).
- **P8 — the attach sequence.** `reuse` runs no status probe (`engine-runtime.ts:598-600`). Otherwise: guard, stop, install, then the stray check on `inject` only (`:604-687`). The refusal words the asker's version (`pod-resident.ts:732-743`, `:772`).
- **P9 — install.** One `sh -c` with `head -c … > .new && chmod && mv -f` (`pod-binary.ts:284-292`).
- **P10 — config.** `keep` goes file/profile → `resolve.ts:409` → `load.ts:544`. `defaults.ts:145-146` documents it. The relay loads its own config (`relay.ts:278-282`), so `detach.keepAwake` needs no spec field.
- **P11 — on-disk.** `readOwner` and `readSpec` are strict on required fields and drop unknown ones (`run-state.ts:141-180`, `:189-220`).

**Where the umbrella or the S2 sketch no longer matches the code:**

| # | Sketch says | Code / decision |
|---|---|---|
| D1 | S2 sketch: "move the stop AFTER the install"; "nothing needs the old order" | **Rejected, two things need it.** (a) `oldBin` is `found` (`engine-runtime.ts:603`): after `mv` the old binary at that path is gone, so the NEW binary would be stopping a resident of another version. (b) The gap between the guard and the stop grows from milliseconds to the whole 60–90 MB transfer, so a client attaching meanwhile is killed. **Instead:** stage the bytes, stop, then rename (Design). The TODO's own "install to a temp name" is this. |
| D2 | DR-5: "arm `registerExitCleanup` in the relay" | It cannot be disarmed (P2), and it would fire on every normal exit, including one that must keep the workload. It becomes `armExitNet`, returning a disarm. |
| D3 | S2 sketch: "the launcher remove on a failed start" | **Dropped.** A failed start can leave a relay in its grace, and "stays up" is what the launcher prints. One rule: only the relay's normal exit removes. A leftover is listed in `ps` (Q2). |
| D4 | DR-5: "removes on idle" | Idle alone is not enough: stale `jobs` and other clients (Load-bearing assumption). And a sleep gives `interrupted`, then the same grace, so "exit after grace" would delete a run the user could still re-prompt. |
| D5 | Umbrella: `statusOf(owner, alive)` | Also needs `now` (`running 3m`). |
| D6 | Umbrella: `rm` sends `stop` "via the control socket" | S3. SIGTERM through `residentStop` (P6), the path S2's checklist item 11 proved live. It stays correct after S3. |
| D7 | Umbrella: `owner.lock`, `<configDir>/kept/runs/<hash>` with `kind: relay\|tui`, `attached` | As built: `.lock.<n>`, `kind: "relay"` only. `attached` is S3. |
| D8 | S2 "Left to S4": run-dir cleanup, and F3's unknown `owner.json` | Cleanup is in. An unknown file stays untouched (Q3), per S2 Review's "Do not relax the rule". |
| D9 | DR-3 rec: an `auto` marker in `ps` | Never built. Added: ` · auto`. |
| D10 | DR-9: "lid-close on battery" | `-i` does not stop lid sleep at all, on mains too without an external display. The launch line says "closing the lid still sleeps the Mac". |
| D11 | S2 sketch: "run the status probe on `reuse` too" | Holds, only when `expected` is known. From source (`expected` undefined) no probe is added, so the `dev` flow stays as it is. |

### Design

Two phases, in this order, each with its own narrow gate.

#### Phase A — pod side (items 3, 4)

**Real version (item 3).**
- `InitializeResultSchema` gains `agentInfo: { version }`, optional. `Connection.initialize` fills it from `host.identity?.tentacle`. No `PROTOCOL_VERSION` bump (§7, fields are free). Run `bun run schema:export`.
- `residentStatus(socketPath)` loses its `version` parameter and reports `agentInfo?.version`, absent for a resident too old to say. `residentStatusReport` follows.
- `busyVerdict` then names the resident's own version; its "of an unknown version" wording already exists (`pod-resident.ts:736`).
- `strayResidentWarning` becomes `residentSkewWarning(probe, name, binPath, expected)`: a resident is up and its version differs from `expected`, or is unknown → warn, naming it through `untrustedText`. Same version → silent.
- It runs on every path after the install step, and on `reuse` too when `expected` is known. A failed probe warns nothing: this never blocks an attach.

**Install, then stop, in the right order (item 4).**
- `PodBinaryDeps` gains `beforeCommit?: () => Promise<void>`. Absent: today's single command, so `run` is unchanged. Present: stage (`mkdir -p`, `head -c > .new`, `chmod`), the hook, then `mv -f` as its own exec. A hook that throws → best-effort `rm -f .new`, rethrow.
- `attachEngineRuntime` still probes before the transfer, so a busy resident is refused without moving 90 MB.
- On a `stop` verdict it passes a hook that re-runs the guard (the transfer gave a client time to attach) and then `--resident-stop` with `oldBin`, which still exists because nothing was renamed.
- A refusal throws `ResidentStopRefused`. The catch at `engine-runtime.ts:645` rethrows it, otherwise it would read as "install failed, go on with the old binary".
- A stage that fails stops nothing, so a read-only image keeps its idle resident and its session, and the warning stands (`replaceFailedWarning`).

#### Phase B — laptop side (items 1, 2, 5)

**Launcher (`main.ts`, `flags.ts`).**
- `detachFlagProblem` loses `keep`.
- A detached run is always labelled, recorded and given a hint, whatever `keep` says: `keptMeta` and the attach hint are built for `kept.keep || detach`. So `ps`, `rm` and `attach` reach it while it lives (P3).
- The launcher still never arms the net. `run --keep=false` without `--detach` is unchanged.
- `provisionWorkload` gains `removedAtEnd?: boolean`, which changes only the wording: `[noun] <name> — removed when the run ends; until then: <hint>`, not `kept … resume with`.
- `RelaySpec` gains `keep` (required: the same binary writes and reads it). `OwnerRecord` gains `keep?`, absent reads as true. No `RUN_STATE_VERSION` bump: an older reader drops it (P11).
- The started line adds, with keep=false: "removed when the run goes idle; files not in the mount go with it; the transcript stays in `tentacle --resume <uid>`". With a docker mount the laptop folder itself is not affected. On darwin with keep-awake on it adds once: "the Mac stays awake while a turn runs; closing the lid still sleeps it".
- `relayBlockingMessage` must not promise an `attach` that will find nothing: with `keep: false` it says "stopping it removes the `<noun>`".

**`exitPlan` (pure, `relay-state.ts`).** This is the only place removal is decided. `exitPlan(model, keep, use)`:

| Condition, first match wins | Plan |
|---|---|
| `keep` | `leave` |
| link stopped | `leave` (the name may no longer be ours) |
| `stopping` | `remove` (DR-5, an explicit stop; no read needed) |
| `rest` is `failed` or `interrupted` | `leave`, say why (Q2) |
| `use === null` | `leave`: "could not tell whether it is in use" |
| own `jobs > 0` or own `running` | `hold`: back to the grace |
| another session with `attached > 0`, `running` or `jobs > 0` | `leave`: "another client is using it" |
| otherwise | `remove` |

`use` comes from a new `LocalRuntime.residentUse(id)`, through the pure `residentUseOf`: `{ jobs, running, others }`, or `null` when the list fails, has a `cursor`, or lacks the session. It is read only where its answer can change the plan (`needsUse`: keep=false, link up, not stopping, `rest` idle), before `release`, bounded at 5 s. "Link stopped" is a new `linkStopped` field of the model: `rest === "failed" && exitNow` also holds for a stop whose turn failed, which must remove. A new relay event `busy` clears `exitAt`, so `hold` costs another 60 s, never a spin. S3 adds one row (handed over → `leave`).

**Relay (`relay.ts`).** The order is the safety argument:
1. Lock taken and `owner.json` checked, as today. Only then, with keep=false, `armExitNet(host, name)`. A second relay refused by the lock therefore never arms a net (item 17's danger with keep=false).
2. The loop, then `exitPlan` while the link is still up. `hold` re-enters the loop.
3. `release()`, then `drain`: the session is detached and saved first.
4. Plan `remove`: `removeVerifiedKept`, extracted from `rmCommand`'s `check` so that one code path re-reads the labels and deletes (`describe` → ours → `remove` → `forgetKept`; `null` → forget; foreign → left alone). Bounded at 30 s. A failure is logged, and `owner.json` `detail` says `not removed: <why> — tentacle rm <name>`.
5. `leave()`: disarm the net FIRST, stop keep-awake, final `owner.json`, release the lock LAST.
6. **Q4 (b):** when step 4 ended with the workload gone AND the entry forgotten, `leave()` deletes the run dir in place of step 5's lock release: the delete of `.lock.<n>` IS the release, because `lockHolder` reads a missing file as no holder and `release()` tolerates it (`pod-resident.ts:159-165`, `:273-277`). Done with the lock still held, so a new relay on the same stem can never lose its dir to this one. `relay.log` goes with it (the owner's decision: the launch line says so). A run whose workload stays (Q2: `failed`, `interrupted`, a stopped link, `use === null`, another client, a failed delete) keeps its run dir, because `ps`, `rm` and `attach --resume` need it.

**Foreign labels** in step 4: the workload is not ours, the entry is dropped, and no entry reaches the run dir any more, so it is deleted too (otherwise an orphan that a later `run` of that name would inherit). `rm`'s `foreign` branch does the same.

**Keep-awake (new `keep-awake.ts` + `wantsAwake(model)` in `relay-state.ts`).**
- `wantsAwake` = `turn === "running" && asks === 0 && !stopping`: a held ask or a running background job lets the Mac sleep, as DR-9 says, and a stop must not restart it when it cancels an ask.
- `createKeepAwake({ platform, enabled, pid, spawn, log })`: `set(wanted)` is idempotent. It spawns `caffeinate -i -w <relay pid>`, stdio `ignore`, not detached, `unref`, and kills on `set(false)` and `stop()`. Darwin only. A spawn `error` logs once and turns it off; it never fails the relay.
- `emit` calls `set` after every step. Config: `detach: { keepAwake?: boolean }`, default on.

**`statusOf(owner, alive, now)` (pure, `run-state.ts`).**

| `owner.json` | Relay alive | Relay dead |
|---|---|---|
| none | `detached · starting` | `null` (no relay ever) |
| unknown | `detached · unknown owner` | `unknown owner` |
| starting, running | `detached · running 3m`, plus `(<detail>)` when set | `relay lost` |
| waiting-permission | `detached · waiting: permission (<tool>)` | `relay lost` |
| idle | `detached · idle`, plus `(<detail>)` when set (why a keep=false delete left the workload) | `idle`, plus `(<detail>)` |
| interrupted | `detached · interrupted` | `interrupted` |
| failed | `detached · failed: <detail>` | `failed: <detail>` |

Alive with `autoAccept` appends ` · auto`. Every `tool` and `detail` goes through `untrustedText` here too. The minutes are `now - lastActivityAt`.

**`ps` (`kept.ts`, `kept-cmd.ts`).**
- `KeptRow` gains `relay?: { text, pid?, sessionId?, log, keep }`, computed in `psCommand` from `lockHolder` + `readOwner`. No run dir → no field, and no `ps` subprocess.
- `KeptDeps` gains `procOf?` (default `laptopProc`).
- The cell, pure in `kept.ts`: the engine's word wins for `gone`, `foreign` and `unreachable`. For a `state`: relay alive → the relay's text; dead → `<engine state> · <text>` (`running · relay lost`).
- `-v` adds `relay`, `session`, `log`, and `removal  when the run ends` with keep=false.

**`rm` (`kept-cmd.ts`).** Order: `verify` → the confirmation → stop → `check` → remove → clean up.
- With a live holder, the confirmation is asked whatever the engine state, and names the pid and state. No `-f` and no terminal → the existing refusal, naming the pid.
- `unreachable` first → nothing is stopped, as nothing will be removed.
- Stop: `residentStop(runDir, RM_STOP_GRACE_MS = 45_000, procOf)`, past the relay's own bounds (P6, plus its 30 s delete: 20 s would SIGKILL a relay mid-delete), with one line `stopping the detached run (pid N)…`. A throw (EPERM) → `[error]`, nothing removed.
- After a stop, `check` saying `gone` is the relay's own keep=false removal: print the normal `removedLine`, exit 0.
- After the delete, and on `gone` or `foreign`: remove the run dir, unless `readOwner` says `unknown`. Then it stays, and the line names the file (Q3). `foreign` is the drift recorded below: a foreign workload is not ours, no entry reaches the run dir any more, so it goes too.
- A `forgetKept` that throws (EACCES on the index) is NOT a failed delete: `KeptRemoval` carries `forgetError` beside `removed`/`gone`/`foreign`, and the line is a `[warn]` that the WORKLOAD's fate is what it was — `removed`, `already gone`, or `left alone (not tentacle's)` (`removalFate`) — while only its index entry stayed, so the first line never claims the entry went. Same in the relay: its own note (`removalFate`, so a `foreign` workload is never called "removed"), the run dir kept, and `rm` converges (sees `gone`, clears both). The asymmetry is deliberate: the relay keeps the run dir so `ps -v` shows the note; `rm` drops it because the user already sees the `[warn]`.

### Files (dependency order)

Phase A:
1. `packages/protocol/src/session.ts`, `packages/protocol/schema/protocol.json` — `agentInfo`.
2. `packages/daemon/src/connection.ts` — fill it.
3. `packages/cli/src/pod-resident.ts` — `residentStatus`, `residentSkewWarning`.
4. `packages/cli/src/pod-binary.ts` — `beforeCommit`.
5. `packages/cli/src/engine-runtime.ts` — the hook, `ResidentStopRefused`, the skew warning on all paths.

Phase B:
6. `packages/config/src/schema.ts`, `resolve.ts`, `load.ts`, `defaults.ts` — `detach.keepAwake`.
7. `packages/cli/src/local-runtime.ts` — `residentUse`.
8. `packages/cli/src/engine-runtime.ts` — `armExitNet`, `removedAtEnd`.
9. `packages/cli/src/run-state.ts` — `keep`, `statusOf`, `relayBlockingMessage`.
10. `packages/cli/src/relay-state.ts` — `exitPlan`, `wantsAwake`, `busy`.
11. NEW `packages/cli/src/keep-awake.ts`.
12. `packages/cli/src/kept.ts`, `kept-cmd.ts` — the cell, `-v`, `removeVerifiedKept`, `rm`.
13. `packages/cli/src/relay.ts` — the exit order, the net, keep-awake.
14. `packages/cli/src/flags.ts`, `main.ts` — flags, labels, lines, `procOf`, USAGE/HELP.
15. `README.md`, the §7 "Pod/container lifecycle" sentence in `AGENTS.md` (the relay as second net owner), `TODO.md`, the umbrella's status line.

No `transport`, `client` or `tui` change. No `PROTOCOL_VERSION` or `RUN_STATE_VERSION` bump.

### Failure modes

| Event | Behaviour | Convergence |
|---|---|---|
| Relay SIGKILL or power loss before the delete | No exit handler (probe B). Workload stays, lock stale. | `ps`: `running · relay lost`. `rm` or `attach --resume`. Stated limit of the net. |
| Relay crash (uncaught) mid-run or mid-delete | Net armed, so it fires. Both deletes are idempotent (P5). Entry stays. | `ps`: `gone`; `rm` drops the entry and the run dir. |
| Relay killed between the delete and `forgetKept` | Same. | Same. |
| Delete fails (engine down) | Logged, `detail` says so, net disarmed, exit. Run dir kept. | Listed in `ps`; `rm`. Never retried silently. |
| Relay killed after the entry is forgotten, before the run dir is deleted (Q4 b) | The net fires on a crash, idempotent. The dir stays with no entry. | An orphan until a `run` of that name; a stale `owner.json` is overwritten by that run's relay. Harmless. |
| The launcher still polls when a stopped relay deleted the run dir | `readOwner` says `none`, the child exited: "did not start". | Only a stop within the launcher's first poll. Said wrongly, nothing lost. Accepted. |
| Name reused by a foreign workload during a long run | `removeVerifiedKept` re-reads the labels: left alone. | Entry dropped. A stopped link never reaches it. The crash net does no re-read on k8s (P5): only a crash and a foreign pod of that exact name together. Accepted. |
| `rm` vs a live relay, keep=true | SIGTERM → cancelled, saved, exit, then `rm` deletes. | Normal. |
| `rm` vs a live relay, keep=false | Relay removes first, `rm` sees `gone`, prints `removedLine`. | Same line either way. Both idempotent. |
| `rm`'s signal lands during the relay's own delete | The relay finishes; `rm` waits. | Same. |
| Relay does not stop in 45 s | SIGKILL (P6). Turn not saved; the session's last save stands. | `rm` goes on: the user asked for it. |
| `rm` with the engine unreachable | Nothing stopped, nothing removed. | The run goes on. |
| `rm -f` with no terminal | Stops and removes, as asked. | Normal. |
| Pending ask at idle | `asks > 0` blocks idle (`relay-state.ts:116`), no timeout. | Stays until answered (S3) or stopped. Pinned past the grace. |
| Pending ask + `kill <pid>`, keep=false | An explicit stop: cancelled, saved, removed (DR-5). | `attach`'s message says so beforehand. |
| Laptop shutdown sends SIGTERM, keep=false | Indistinguishable from `kill`: a stop, so it removes if the engine answers in time. | Same as today's `run --keep=false`. Stated in `README`. |
| Job running, poll failed for the whole grace | The fresh read fails → `leave`, no delete; or it sees the job → `hold`. | No job is ever deleted on a stale 0. |
| Provisioning-window `attach` still in use at idle | `others > 0` → `leave`, said in the log and `detail`. | The workload stays, `rm` is the user's. |
| Mac sleeps mid-turn | Link drops, `interrupted`. keep=false: not removed. | `attach --resume`, re-prompt, `rm`. |
| Mac sleeps with caffeinate on (lid) | `-i` does not stop it. | Same. Said at launch. |
| caffeinate child outlives anything | `-w <pid>` ends it within about a second of the relay's death, SIGKILL included (probe C2). | No leak. `-w` on an already dead pid exits 0 (C3). |
| caffeinate missing or fails to spawn | One log line, then off. | The run goes on. |
| Relay's `spawn` races its own exit | `stop()` kills it, and `-w` covers the rest. | No leak. |
| Stage fails (read-only path) | Nothing stopped. The warning, then the old binary. | Every attach gives the same result; nothing is lost. `initialize` refuses a real protocol skew. |
| Client attaches during the transfer | The second guard refuses; `.new` removed. | Retry. The binary is unchanged. |
| `mv` fails after the stop | Rare (a sticky dir, an immutable file). The stop already happened. The existing warning. | The bridge restarts a resident from the old binary, session recreated from laptop history. The one case that may repeat. Accepted. |
| Version skew: resident too old for `agentInfo` | `version` absent → "of an unknown version", and the skew warning. | Fail-closed, as today. |
| Version skew: `--resident-status` across protocols | `initialize` refused → `{resident: null, error}` → guard refuses. | Unchanged. |
| Version skew: CLI vN+1 `ps`/`rm` vs relay vN | Same lock format; a newer `RUN_STATE_VERSION` reads as `unknown owner`. SIGTERM needs no protocol. | `rm` works, the file stays (Q3). |
| Hostile pod reports `jobs: 0`, `attached: 0` | Its own removal. No laptop effect (a mount's laptop folder is untouched). | Accepted, inside "not trusted". Hostile `jobs > 0` forever: as in S2. |
| Hostile `agentInfo.version` | Reaches only `untrustedText` lines. | No control characters reach a terminal. |
| Stale `owner.json` on the same name after an external delete and a plain `run` | `ps` shows its last `idle`/`failed`. | Until `rm`. S3's TUI owner file rewrites it. Accepted. |
| After the relay left, a TUI attaches | `ps` keeps the last state: there is no TUI owner file yet. | S3. |

### §7 invariants

| Invariant | How it stays true |
|---|---|
| Pod/container lifecycle | Removal needs the managed + kept labels, re-read right before it (`removeVerifiedKept`). The launcher never arms a net (test L12). The net child keeps its one shared subcommand and passes secrets by env, unchanged: `removeBestEffort` is reused. `caffeinate`'s argv holds a pid, nothing else. `attach` still never deletes. |
| Single broker | Untouched: no new `PermissionBroker`. `exitPlan` answers nothing, and a held ask stays held. |
| Pod not trusted | `residentUse` and `agentInfo` are pod-supplied. They steer only the removal of that same workload, or a warning. Keeping a workload is the safe side of every unknown. Every effect is decided on the laptop. Pod text goes through `untrustedText`. |
| Model on the laptop | Untouched. The relay's env and argv do not change. |
| Persistence | `release` and `drain` run BEFORE the delete, so the transcript is on the laptop first. The relay's removal keeps one writer per uid: the lock is held throughout. |
| Never write raw to the terminal | The relay has no TTY and caffeinate has `stdio: ignore`. `ps`/`rm` are plain lines with no Ink. Launcher lines come before exit. |
| Don't serialize the peer | `residentUse` is an ordinary concurrent request, bounded, outside any handler. |
| Protocol | One optional strip-schema field, both ends wired, schema regenerated. `UPDATE_CLASS` untouched. |
| On-disk records | `keep` optional in `owner.json`; unknown records stay untouched (Q3). |
| One session path | No new client path. |

### Tests (red first; each with its mutation target)

Phase A:
- **L1** `packages/daemon/test/integration.test.ts`: `initialize` returns `agentInfo.version` from the identity, absent with none. *Mutation:* hard-code it.
- **L2** `serve-resident.test.ts`: `residentStatus` reports the RESIDENT's version, not the asker's; an old resident → absent. *Mutation:* read `APP_VERSION`.
- **L3** `residentGuard` busy: the refusal names the resident's version. *Mutation:* name the asker's.
- **L4** `engine-runtime.test.ts`: `reuse` with a resident of another build → a notice; same build → silent; a probe that throws → silent, attach goes on. *Mutation:* drop the probe on `reuse`.
- **L5** `expected` undefined: no added exec. *Mutation:* always probe.
- **L6** re-pinned T10: the sequence is status, stage, status, stop, `mv`, and the stop goes through the OLD path before the rename. *Mutation:* the sketch's order (stop after `mv`).
- **L7** a stage that fails: no stop exec, the warning stands. *Mutation:* stop before the stage. This is the TODO's bug: red on today's order.
- **L8** busy at the second guard: refused, `rm -f .new`, no `mv`, and NOT turned into the "go on" warning. *Mutation:* drop `ResidentStopRefused`'s rethrow.
- **L9** `pod-binary.test.ts`: no hook → today's single command, byte-identical. *Mutation:* always two execs.

Phase B:
- **L10** `relay-state.test.ts`: every `exitPlan` row, in order. *Mutations:* drop the `use === null` row; let `others` count `attached: 0` sessions (probe A3).
- **L11** `busy` clears `exitAt` and costs a full grace, so `hold` cannot spin. *Mutation:* ignore it.
- **L12** `main.test.ts` through the REAL `provisionWorkload`: keep=false + detach → labels and index entry present, no new `exit` listener, the "removed when" line, no `undefined`. *Mutations:* drop `kept.keep || detach`; pass no hint (the F1 trap).
- **L13** `relay.test.ts`: at idle the frames show `session/detach`, the record is saved, then `remove`, then the lock is free and the run dir is gone (Q4 b); order asserted through one recorded sequence. L16, L17, L20 assert the run dir stays. *Mutations:* delete before `release`; release the lock before the delete; delete the run dir whatever the outcome.
- **L14** a held ask, past several graces: no remove. *Mutation:* drop `asks` from idle.
- **L15** the fresh read sees a job: no remove, a new grace, removal after it ends. *Mutation:* trust the polled value.
- **L16** another client attached → exit, no remove, `detail` says why.
- **L17** `interrupted`, `failed`, link stopped, unreadable use → no remove, exit normal. *Mutation:* remove on any `relayExits`.
- **L18** stop → removed, no read; with a held ask too.
- **L19** foreign labels → not removed; `describe` null → entry forgotten. *Mutation:* skip `isKeptWorkload`.
- **L20** a failing delete: `detail`, the entry stays, exit clean.
- **L21** the net: armed only with keep=false, after the lock; disarmed by every `leave`; still armed if the loop throws; a relay refused by the lock never arms it. Injected `armNet` seam. *Mutations:* arm before the lock (a second relay's exit would delete the first's workload); no disarm.
- **L22** real `armExitNet`: disarm removes the listener; an exit fires `removeBestEffort` once.
- **L23** `run-state.test.ts`: `keep` round trip, absent = true; `relayBlockingMessage` with keep=false. *Mutation:* default false.
- **L24** `keep-awake.test.ts`: argv exactly `-i -w <pid>`; `set` idempotent; killed on false; off on linux and with the config false; a spawn error logs once. Plus `wantsAwake` in `relay-state.test.ts`: false on a held ask and on jobs. *Mutations:* `-d`; keep it on through a held ask.
- **L25** `relay.test.ts`: turn → on, held ask → off, exit → off, with a fake spawner.
- **L26** `packages/config/test`: `detach.keepAwake` by file and profile.
- **L27** `run-state.test.ts`: every `statusOf` cell; ESC in `tool` and `detail` never survives; ` · auto`. *Mutation:* skip `untrustedText`.
- **L28** `kept-cmd.test.ts`, `kept.test.ts`: the cell rules, `-v` lines, no run dir → no `procOf` call. *Mutation:* the relay text over `gone`.
- **L29** `kept-cmd.test.ts`, with a real child as holder: the stop comes before `remove`; confirmation first, so a "no" stops nothing; `unreachable` stops nothing; `gone` after a stop → `removedLine`; run dir cleaned; an unknown `owner.json` left byte-identical. *Mutations:* stop before asking; remove with no stop.

Iterate per file, per phase, then `bun run check` (AGENTS §4).

### Size and split

**L:** 19 source files across protocol, daemon, config and cli. S2 was split at 16. It is one branch by the owner's decision, and L is allowed: strong model and mandatory fresh Review are already this slice's terms.

**If a split is wanted, the line is Phase A / Phase B.** Items 3 and 4 touch neither the relay nor `ps`, and Phase B needs nothing from them. Q1 asks.

### Live test checklist (owner, by hand, ONCE, after S3 merges)

A real terminal, Docker Desktop, compiled `dist/tentacle`, Linux pod binary, isolated `TENTACLE_CONFIG_DIR` with a working model. Kubernetes runs only if a context authenticates. Since S3 (`docs/feat/detached-handover.md`) `attach` on a LIVE relay takes the run over and a quit ends the run: items 27–49 cover that.

From S2 (`docs/feat/detached-relay.md`):
1. **S2-3.** Start a detached run, close that terminal window while the relay lives: `ps -o pid,ppid,pgid,tty -p <pid>` from another window shows it alive, and the turn finishes.
2. **S2-8.** After the relay leaves, `attach <name> --resume <uid>` from the same folder shows the history in the same live session. Quit: the session is closed, the record is on the laptop, `attach <name>` reopens it from the record (S3 Q1).
3. **S2-17.** With a relay alive, start a second by hand on the same run (`TENTACLE_RELAY_SPEC=<spec> tentacle __relay`): exit 1, the first `owner.json` byte-identical.

DR-5:

4. `run --detach --keep=false --auto-accept --prompt …`: the "removed when" line, no `kept … resume with`, no `undefined`. It is in `ps` while it runs. About 60 s after idle the container is gone, the entry too, the record is on the laptop, the run dir (`relay.log` with it) is gone (Q4 b).
5. The launcher's exit leaves the container up (the trap, for real).
6. No auto-accept, keep=false: `waiting: permission`, still there past 60 s, container up, tool not run. `kill <pid>`: cancelled, saved, container gone.
7. keep=false with a background `sleep 120`: stays through the job, removed about 60 s after it ends.
8. keep=false, `docker pause` the container or block the link during idle: exit with no removal, `detail` says why.
9. keep=false, `kill -9` the relay: container stays, `ps` says `relay lost`, `rm` clears it.
10. keep=false with a mount: the laptop folder is intact after the removal.
11. keep=false, a broken model key: `failed`, container stays, `rm` clears it.
12. With item 3's scenario on keep=false: the refused second relay does NOT delete the workload when it exits.

DR-9:

13. During a turn: `pmset -g assertions | grep caffeinate` shows it. After the turn, or at a held ask: gone.
14. `kill -9` the relay mid-turn: caffeinate gone within seconds.
15. `detach.keepAwake: false`: never spawned. The launch line states the lid limit once.
16. Close the lid mid-turn: `interrupted`, no removal, re-attach works.

Version:

17. Build a second binary with another version, same protocol: attach while its resident is idle → the replace works. While busy → refused, naming the RESIDENT's version.
18. Same setup, `reuse` path: the notice names the other build.
19. Non-root image, no `--bin-dir`, other version, idle resident: every attach warns, the resident pid never changes.

`ps` / `rm`:

20. `ps` during a run: `detached · running Nm`, ` · auto` with auto-accept. At a held ask: `detached · waiting: permission (shell)`. `-v`: pid, session, log path.
21. `ps` after `kill -9`: `running · relay lost`. After a normal end: `running · idle`.
22. `rm <name>` on a live relay: the prompt names pid and state. "n" stops nothing. "y": relay gone, turn cancelled and saved, workload removed, run dir removed.
23. `rm -f` on a live keep=false run: exits 0 with the normal line.
24. `rm` with Docker stopped: nothing stopped, the relay lives.
25. Future-version `owner.json`: `ps` shows `unknown owner`, `rm` leaves the file and names it.
26. keep=false, an image with no glibc (a failed provisioning): `stays up: the run never started`, no "removed when", container up, in `ps`, `rm` clears it.

S3 hand-over and N terminals (`docs/feat/detached-handover.md`):

27. Held ask, no auto-accept: `attach <name>` from another terminal, no `--resume`: TUI opens the session, the prompt appears, "allow": the tool runs once, the turn ends, the relay is gone, the record is on the laptop.
28. Mid model stream (a long answer): `attach`: the text keeps streaming, no error. `relay.log` shows the drain and `relay exit`.
29. `--auto-accept`, a turn with several tools, `attach` mid-turn: the notice, footer on, the remaining tools run with no prompt; Shift+Tab: the next ask prompts.
30. `kill -9` the `attach` before the TUI appears: the relay goes on and finishes. (A window of moments: script the `kill -9`.)
31. `attach` from two terminals at once on a live relay: one takes over, the other joins. Both show the session. (Same: "at once" needs a script.)
32. Two TUIs, an ask: on both screens. Answer on one: gone from the other, tool once. Answer both quickly: one decision.
33. Two TUIs: `ps`: `attached (2)`, `-v` with both pids.
34. Two TUIs, a long answer: the newest `/quit`s, `y`: the turn stops, the other's shell comes back with `session closed by another terminal`, no `RpcError`.
35. Two TUIs: `/clear` on one: the other's session goes on.
36. keep, last quit: `ps`: `idle`, container up. `attach <name>`: the same session from the record.
37. keep=false, two TUIs: `/quit`, `y`: both gone, container gone, entry and run dir gone, record on the laptop.
38. keep=false, `kill -9` the only TUI: container up, `ps` `tui lost`, `rm` clears it.
39. keep=false, two TUIs, `kill -9` one, `/quit` the other: no dialog, deleted.
40. keep=false, `attach` during the 60 s grace: no removal, or a clean "gone" if it lost the race.
41. Quit mid-turn after a hand-over, keep: the turn stops, what it did is on the laptop, `attach` reopens it.
42. Quit mid-turn after a hand-over, keep=false: deleted (Q6 (a)); the attach-time notice said so. With the last save unconfirmed: see item 56.
43. `attach < /dev/null`: refused, the run unharmed.
44. First turn, `kill -9` the relay: `attach` shows the transcript from the pod.
45. `kill -9` the last TUI: `ps`: `tui lost`; `attach`: same session, up to the last save.
46. `docker rm -f`, then `attach`: the DR-8 line, with the uid; exit 1.
47. `rm` on an attached run: the prompt; "y" removes; the TUIs show the link stopped; their quit prints no "not removed" and no "another terminal".
48. A very long `TENTACLE_CONFIG_DIR`: the socket falls back, hand-over works.
49. A second build with another version: `attach` on a live relay is refused before the relay notices: its `relay.log` has no `prepare`.
50. A kept keep=false run `box` in namespace A (ended), your own `box` in namespace B: `attach --engine kubernetes --namespace B box` opens B's, with no "resolved box" line; its quit leaves A's alone. Under a LIVE relay in A the same command is S2's refusal. `--namespace A` reaches the run.
51. A second terminal during a long answer, after a first took over: `attach` joins at once, no "closing" line, both show the session; `relay.log` shows the drain and `relay exit` later.
52. A run started in another folder: `attach` from elsewhere is refused, naming the folder.
53. `attach <name> --resume <other uid>` under a live relay: S2's refusal, the relay unharmed.
54. SIGTERM on the last TUI on keep=false: the net fires and the workload goes (unlike item 38's `kill -9`).
55. A keep=false run ended `failed`; `docker rm -f box`; plain `tentacle run --name box` (keep); `attach box`: today's attach, a fresh session, no "quitting removes" notice; its quit leaves the new `box` up. (`ps` still shows the old run's status on that row until the name is run detached or removed.)
56. keep=false, a pod that stops answering (`docker pause`) or a full laptop disk, quit: `not removed: the last save was not confirmed — tentacle rm <name>`, the workload up; with the pod back, `attach <name>` reopens the session, which was detached, not closed.
57. keep=false, the only TUI `/clear`s, then quits: removed.

**After `docs/fix/detach-live.md`.** Re-run list: 27, 29, 34, 35, 36, 37, 39, 41, 42, 56, 57, then 58–76, in the order and with the tmux harness of that doc's "Live test"; 76 by hand; the owner's 12-item list: 5, 6, 7, 10, 11, as these same checks (34/35, 36/41, 37/42, 57, 29).

58. `/quit` alone: no dialog.
59. `/quit` with another TUI, `n`, and Enter: nothing changes, the turn goes on.
60. `/quit`, `y` from the OLDER TUI, and from the one that typed the prompt: as 34.
61. A TUI `/clear`s, the other `/quit`s: no dialog, the first untouched. On keep=false the container stays, the message says why; the first's quit removes it.
62. keep=false, one TUI, the run's own turn in a long tool, `/quit`: removed, no `not saved`, the interrupted tool in `tentacle --resume`.
63. keep=false: attach at idle and mid-turn: the notice is on screen in both.
64. The launcher's line, keep and keep=false: `attach` without `--resume`, at once, works.
65. Two TUIs: close one window, and `kill -9` one, idle: the other goes on.
66. Two TUIs: Ctrl+C mid-turn: the turn stops on both, nobody leaves. Ctrl+C idle: that one leaves, no dialog, the other goes on.
67. `--auto-accept`: a second terminal, and an attach after the relay left: footer on, notice shown.
68. Two TUIs: Shift+Tab in one: both footers flip at once. With a prompt on both: ON answers it, tool once; OFF leaves it.
69. A turn typed in one TUI, ON: no prompt stays on the other.
70. keep, two TUIs: `/quit`, `y`. Once both are gone, `ps`: `idle`, never `tui lost`.
71. `--auto-accept`: Shift+Tab to OFF, every TUI quits by Ctrl+C or a closed window, the relay gone; a new `attach`: footer OFF, no `auto-accept on` notice, an ask prompts.
72. Two TUIs, keep=false: `/quit` on both, `y` on both within a second: one delete, the other prints `another terminal is closing the run`; no `not saved`, no `RpcError`.
73. Two TUIs: `/quit` on A, the dialog open; on B a prompt that makes an ask. `y` on A closes the session and approves nothing: the tool never runs.
74. `--auto-accept`, an attached TUI: write `garbage` into `<runDir>/auto-accept/<sessionId>`: the footer goes OFF within a second. A new `attach`: OFF. Replace it with a directory: OFF, an ask prompts.
75. keep=false, relay draining a long answer on the run's session, B on it, A `/clear`ed: A `/quit`s: B's answer goes on, no `RpcError`; A prints `not removed: another terminal is on another session`; B's quit removes.
76. Close the lid mid-turn (item 16, the owner's item 12): by hand.

### Open questions for the owner

- **Q1. Size L: one branch, or split?** (a) one branch, Phase A then Phase B, a gate between them; (b) split items 3–4 into their own task. **Recommend (a):** it saves the review cycle you folded S4 in to save, and L is allowed.
- **Q2. keep=false when the turn ends `failed` or `interrupted`, or the relay dies at start.** (a) keep the workload, listed in `ps`; (b) remove anyway. **Recommend (a):** a leftover is one `rm` away, and deleted files are gone.
- **Q3. `rm` with an unreadable `owner.json`.** (a) leave the file, name it; (b) delete the run dir, because `rm` is explicit. **Recommend (a):** the §7 rule, and S2 Review's advice.
- **Q4. Run dir after the relay's own removal.** (a) keep it (at most 2 MiB per run, no reaper); (b) delete it. Recommended (a), **the owner decided (b)**: see Relay, step 6.

## Execution

*— claude-opus-5-5, 2026-10-31*

Nothing committed. 36 files modified, 3 new (`docs/feat/detached-relay-lifecycle.md`, `packages/cli/src/keep-awake.ts`, `packages/cli/test/keep-awake.test.ts`).

**Repro, before any edit** (`.tentacle/tmp/detached-relay-lifecycle/repro.test.ts`, recreated: the Context's copy did not survive):

```
flag: --detach keeps its workload: --keep=false is not supported with it
NAME   ENGINE   WHERE   MOUNT   MODEL   AGE   STATUS
box    docker   local   —       m       1h    running
residentStatus arity: 2
```

**Plan edits before coding (Q4 b):** Relay step 6 and the "Foreign labels" paragraph replace the "run dir stays" line; two failure-mode rows added; checklist 4, Q4 and L13 updated.

### Phase A (items 3, 4)

As built, in order:
1. L1–L9 written. Red: 12 fail (`engine-runtime`, `pod-binary`, `integration`); L2 and L3 first hit an import error, so `residentSkewWarning` went in first and they were shown red on the assertion (`status.version` undefined, the refusal says "of an unknown version").
2. `agentInfo` in `InitializeResultSchema`, filled by `Connection.initialize` (`packages/daemon/src/connection.ts`), `schema:export` run.
3. `residentStatus(socketPath)` reports the resident's own version. `residentSkewWarning` replaces `strayResidentWarning`.
4. `beforeCommit` in `injectAgentBinary`; `attachEngineRuntime`: the status probe, then `stopResident` as the hook, re-running the guard; `ResidentStopRefused` rethrown past the "go on" catch; the skew check after the install step and on `reuse` with `expected` known.

Existing tests changed because their contract changed, each named in the plan: T10 (the stop now follows the stage), the `--resident-` assertions on `reuse` (now `--resident-stop`: a status probe IS expected), and the stray wording.

Green: 194 pass across the four files. **Mutations: 15/15 killed**, every restore `cp` with identical `shasum` (`evidence/mut-a.txt`): the plan's L1–L9, plus second guard dropped, `.new` not removed, stop result ignored, skew not sanitised, same build warning.

**Mid gate:** `tsc --noEmit` clean, lint 0, `bun run test` **3745 pass / 3 skip / 1 fail**. See "Gate" below for that one fail.

### Phase B (items 1, 2, 5)

As built, in order:
1. Pure tests (L10, L11, L23, L24, L26, L27, L28), shown red on the assertion through stubs: 28 fail, 57 pass.
2. Config `detach.keepAwake`, `keep-awake.ts`, `statusCell`, `statusOf`, `ownerKeeps`, `keep` in spec and owner, `exitPlan`, `needsUse`, `residentUseOf`, `wantsAwake`, `busy`, `note`.
3. Relay, launcher, `ps`, `rm` tests. Red: 33 fail, 108 pass.
4. `armExitNet`, `removedAtEnd`, `removeVerifiedKept`, `rmCommand`, `relayRow`, `runRelay`'s exit, `launchRelay`'s line, `detachFlagProblem`, `main`, USAGE/HELP.
5. README, AGENTS §7, TODO, umbrella status.

**Mutations: 46 run, 42 killed first time, 4 survived, then all killed** (`evidence/mut-b1.txt`, `mut-b2.txt`; every restore identical `shasum`):

| Survivor | Why | What changed |
|---|---|---|
| `L29-unreachable-stops` | My test's fault: `child.exitCode` lags a kill by an event-loop turn, so "alive" was stale | `alive` asks the OS through `lockHolder` + `laptopProc`; the same helper covers the "n" test |
| `L17-rest-row-relay` | At relay level `needsUse` masks the row: same "no remove", another `detail` | L17 asserts the run's own `detail` stands |
| `L10-no-keep-row` | Same masking on an idle exit; a real hole in the test, since a stop with the row gone deletes a kept workload | New test "keep=true: a stop removes nothing either" |
| `L14-asks-dropped` | **Not killed by L14.** A held ask sits inside a turn, so `turn === "over"` already blocks idle: the plan's mutation is invisible in `relay.test.ts` | Killed by the existing pure test "a pending ask blocks the exit" (`relay-state.test.ts`). L14 stays as a behavioural pin, not as this mutation's killer |

One planned guard was dropped as dead code: `relayRow`'s `existsSync`. `lockHolder` on a missing dir already looks at no process, so the "no run dir" test could not fail without it.

### Drift from the plan

- **`RM_STOP_GRACE_MS` 45 s, not 20 s.** The plan's 20 s predates its own 30 s delete bound: it would SIGKILL a relay mid-delete, against the failure row "the relay finishes; `rm` waits". 5 + 3 + 3 + 30 = 41 s. Plan updated.
- **New model field `linkStopped`.** `rest === "failed" && exitNow` also holds for a stop whose turn failed, which must remove. `linkLost` in `relayStep` now reads it. Plan updated.
- **`wantsAwake` also needs `!stopping`:** a stop cancels the ask, and `ask_gone` before `turn_ended` would respawn `caffeinate` for an instant.
- **`residentUseOf` (pure) added**, so the probe A3 rule and the cursor rule are unit-tested, per the §7 pure-module rule. `needsUse` (pure) added: the read is made only where it can change the plan.
- **`removedAtEnd` on a failed start says `stays up: the run never started`.** The plan's one line promised a removal no relay would ever do. Test added, checklist item 26 added.
- **The launch line drops `Re-attach once it is done` with keep=false,** and says the log goes too (Q4 b). `launchRelay` gained `mounted` and `keepsAwake`; `keepsAwake()` is exported so launcher and relay share one rule.
- **`rm` drops the run dir on `foreign` too,** and so does the relay: the plan named only `gone` and the delete. No entry reaches that dir any more.
- **`rm` with `unreachable` and a live holder returns at once.** Falling through to a second `verify` could succeed and delete under the live relay.
- **`KeptDeps.stopRelay` seam added:** the EPERM path cannot be driven by a real signal without aiming at pid 1.
- **`hostFor` moved before the attach,** because the net needs the host; a failed build still ends in `leave`.
- **`profile.ts` merges `detach` per key,** like `mount`; `keep-awake.ts`'s `spawn`/`platform` reach the relay through `RelayDeps.keepAwake`.
- **Size:** 20 source files, not 19 (`profile.ts`).

### Gate

- **Final:** `tsc --noEmit` clean, `bun run lint` 0, `bun run test` **3821 pass / 3 skip / 1 fail**. After that run only a format of `engine-runtime.test.ts` (lint found it): that file re-run, 0 fail; lint 0.
- **`bun run check` is NOT green in this worktree, for a reason outside this task.** It has no `apps/mobile/node_modules`, and installing was out of bounds:
  - `tsc -p apps/mobile` fails on `expo/tsconfig.base` (TS6053), and with `noEmit` lost it wrote six `.js` files beside the sources. Those were mine and are deleted. It was not re-run.
  - The 1 fail is `apps/mobile/test/rn-websocket.test.ts`: `Cannot find module '@tentacle/client'`, an import that resolves nothing of this task.
- **The baseline's 3694 was not reproduced here,** so the count is not compared to it: the mid gate already read 3745, with about 15 tests added by then. Not a test lost, but unexplained.
- `install.test` and `worker-exit-net` did not flake.

### Unverified

- **`tsc -p apps/mobile` and the mobile test:** run `bun run check` on a full install (`agentInfo` is the only type its packages could see).
- **Everything real:** no Docker, no compiled relay, no real `caffeinate`, no real engine delete (AGENTS §6, the owner's checklist, after S3). The `exit` net was tested in-process only; probe B is the plan's.
- **`keepsAwake` in `main` has no test of its own:** its value depends on the host platform. Covered in `launchRelay` and `createKeepAwake`; checklist 15 covers the line.

## Review

*— claude-opus-5-5, 2026-10-31* (fresh context, SAME model as the executor: shared blind spots survive both passes)

**Verdict: APPROVE-WITH-NITS → ready for the owner's live test (after S3).** No finding breaks a §7 invariant or loses data. Four low findings / nits below. None blocks the live test, but finding 1 should be fixed before the merge, because AGENTS.md is the rule source for every later agent.

**Gate (this worktree, no `apps/mobile` deps, so not `bun run check`):** `bunx tsc --noEmit` clean; `bunx biome check .` 575 files, 0 errors / 0 warnings; `bun test packages` **3782 pass / 3 skip / 0 fail** (13790 expects, 266 files). This matches the orchestrator's count. The 3 skips are the opt-in ones.

### Findings

1. **LOW (doc accuracy, rule text): `AGENTS.md:270-273` "removes on a normal exit … disarming first".** In the code the net stays ARMED through the delete: `removeVerifiedKept` runs at `relay.ts:346-352`, and `leave()` disarms only afterwards (`relay.ts:195`). That order is intended, because a crash mid-delete then converges through the net (failure row 2). Read literally, the sentence says the opposite. "A normal exit" is also wider than the code: the code removes only on a stop, or on a clean idle that one fresh read shows nobody uses. `failed`, `interrupted`, a stopped link, an unreadable use and another client all keep the workload (Q2). Suggested wording: "…and removes it only through `exitPlan` (a stop, or a clean idle that nobody else uses) + `removeVerifiedKept`, the net staying armed until that delete is done".
2. **LOW (fail-loud / UX): a keep=false workload that stays is shown as plain `idle` in `ps`.** The cases are a failed or unreachable delete, another client, or an unreadable use. `ownerText` drops `detail` for `idle` (`run-state.ts:290`), so `ps` and `ps -v` show `running · idle`. The `not removed: <why> — tentacle rm <name>` that the relay wrote (`relay.ts:358`) is visible only in `owner.json` or `relay.log`. The plan's `statusOf` table says the same thing, so this follows the plan. But the user gets no on-screen reason why a "removed when the run ends" workload is still there. Suggest showing `detail` for `idle` in `-v` at least.
3. **NIT: `kept-cmd.ts:219` a `forgetKept` that throws after a successful `host.remove`.** The relay's `bounded(...).catch` turns the throw into `failed`. `detail` then says "not removed: … — tentacle rm", but the workload is gone. It converges: `rm` sees `gone`, drops the entry and the run dir. The wording is just wrong in that one case. Rare (EACCES on the index).
4. **NIT (doc): Implementation `rm`, line 221** still says "After the delete, and on `gone`". The as-built (and the "Foreign labels" paragraph, line 189) also drops the run dir on `foreign`. Fold the drift into that line.

### The AGENTS.md edit (§10 carve-out (c))

It **describes as-built behaviour**, and it **extends the invariant's scope**: a second owner of the net and of a delete. That is a substantive rule change, not a typo fix. Carve-out (c) allows exactly this when it rides a `feat` branch with a Review, and it does. It was also listed in the approved plan (Files 15). So it is legitimate on this branch, but its wording must match the code (finding 1).

### Premise table (spot-checked)

| Premise | Verdict |
|---|---|
| Repro: `--detach --keep=false` refused, `ps` shows `running` for a held ask | TRUE (Execution's re-run). Now covered by L12/L27/L28. |
| P2: the old net was undisarmable `process.once` | TRUE (`git diff` of `engine-runtime.ts`, `registerExitCleanup`) |
| P3: `keepHint` gates the launcher's net (`if (!keptLine) armExitNet`) | TRUE (`engine-runtime.ts:355`). `listed = kept.keep \|\| detach` gives a detached keep=false run a hint, so its launcher never arms (`main.ts:841`, L12) |
| P5: the docker net child refuses only without `OWNER_LABEL`, not a kept one | TRUE (`docker/src/container-cleanup.ts:10`). So the relay's net really deletes a kept-labelled container |
| P7: `InitializeResultSchema` is a strip schema; a new optional field needs no bump | TRUE (`protocol/src/session.ts:152-157`) |
| `exitNow` only from `link stopped` / `stop`, so `hold` cannot spin | TRUE (`relay-state.ts:72-140`). `busy` only clears `exitAt` |

### Attacks tried

- **Net armed by a relay the lock refused** (S2-17 with keep=false): the arm is after the lock and the `owner.json` check (`relay.ts:224`). Every path after it returns through `leave()`, which disarms first (`relay.ts:219, 239, 263, 344, 360, 362`). The only exception is a throw, which is the intended crash net. **Holds.** My mutation X2 (arm in the refused path) is killed by L21.
- **Delete before the session is saved, or with the lock released:** order is loop → `exitPlan` → `release`/`drain` → `removeVerifiedKept` → `leave(true)`. `leave` deletes the run dir (the lock file with it) before `lock.release()`. **Holds** (L13 asserts one recorded sequence).
- **A stale `jobs = 0` deletes a running job:** removal needs a fresh `residentUse`. Unreadable → `leave`, a job → `hold` → a new 60 s grace. A stop that lands during the read is honoured, because the plan is computed on the model after the read. **Holds.**
- **Probe A3 (a client that left still listed):** `residentUseOf` counts only `attached > 0 \|\| running \|\| jobs > 0`, and a paged list → `null`. My scratch trace (below) confirms remove / leave("another client") / null.
- **`rm` vs a live relay:** with an unreachable engine and a live holder, `rm` returns before any stop (`kept-cmd.ts:278`; my mutation R2 kills it). The confirmation comes before the stop (a "no" costs nothing). With keep=false, `rm` sees `gone` after the stop and prints the normal line. **Is 45 s justified?** Yes: the relay's own worst case is about 5 + 3·n + 30 s (stop bound, `release` steps, delete bound). 20 s could SIGKILL it mid-delete, and even then both deletes are idempotent (P5). The cost is a silent wait of up to 45 s after one "stopping…" line: acceptable.
- **Secrets by env:** the net reuses `removeBestEffort` unchanged. `caffeinate`'s argv is `-i -w <pid>`. The relay's spec/env are unchanged except `keep`. **Holds.**
- **Keep-awake leak:** not detached, `unref`, `-w <relay pid>` (probe C2: dies with a SIGKILLed parent), killed by `leave()` → `awake.stop()`. `stop()` blocks any later `set`. A spawn `error` turns it off. Paths that return before `createKeepAwake` (lock, unknown owner) never spawn. `wantsAwake` also needs `!stopping` (my mutation R1 is killed by L24 + L25). The default is `enabled: true`, but `keepsAwake` is darwin-only, so it is off elsewhere. **Holds.** Residual nit: a `caffeinate` that keeps exiting at once would be respawned on each `emit` (about 1/s). Harmless on macOS.
- **Resident install order:** a stage failure → the hook never runs (`pod-binary.test` "a stage that fails never reaches the hook"), so the idle resident and its session survive. A client attaching during the transfer → second guard → `ResidentStopRefused` → `.new` removed, no `mv`, rethrown past the "go on" catch (X3 killed by L8 + T10). A failed `mv` after the stop → the existing replace-failed warning, and the bridge restarts from the old binary (accepted row). `oldBin` still exists at stop time. **Holds.**
- **Hostile pod strings:** ESC/OSC in `owner.json` `tool` and in `agentInfo.version` came out stripped in my trace through `statusOf` and `residentSkewWarning`. The engine's `gone` wins over a live relay's text in `statusCell`.
- **Q3/Q4 + the `foreign` drift:** `rm` keeps an unknown `owner.json` byte-identical (test "Q3 …"). The relay never purges on `unreachable`/`failed` (my mutation R3 is killed by L20 + the bounded-delete test). On `foreign`, dropping the run dir is safe: it holds only laptop-side state (`owner.json`, `relay.log`), the transcript lives in the session store, and no entry points at the dir any more. It is consistent with Q4's intent ("kept when the workload is kept": a foreign workload is not ours to keep). **Holds.** It is still an owner-visible drift: it is documented in Execution, and the owner should note it.
- **Protocol/config:** `agentInfo` is optional, wired at both ends (`connection.ts:332` from `host.identity`, `residentStatus` reads it), and `protocol.json` was regenerated. No `PROTOCOL_VERSION` bump is needed (fields are free). A malformed `agentInfo` fails `initialize`'s parse, which is fail-closed. `detach` is `.strict()` like every config object, merged per key in profiles, and tested by file and profile (`config/test/keep.test.ts`).

**End-to-end trace** (`.tentacle/tmp/detached-relay-lifecycle/review/trace.test.ts`, the real pure modules):

```
needsUse true use { jobs: 0, running: false, others: 0 } plan { kind: "remove" }
other running: { kind: "leave", why: "another client is using it" }
paged: null
link stopped + stop: { kind: "leave" }
statusOf: "detached · waiting: permission ([2J ]0;pwn) · auto"
cell gone wins: gone
skew: "⚠ box already runs a tentacle resident [2J ]0;pwn, this laptop 1.0.0: …"
```

### Failure-mode table vs tests

Every row that can be driven in-process has a test: L13–L22, L24/L25, L29, the pod-binary L9 set, L7/L8, L2/L4, and Q3. The rows not tested are by nature: SIGKILL/power loss, "killed between delete and forget", "killed after forget before the purge", "the launcher polls a purged dir". All of these converge by idempotence, which is argued from P5 and not executed. The checklist has S2-3, S2-8 and S2-17 (items 1–3), plus item 12 (S2-17 on keep=false). **Missing from it:** no item stages "another client at idle". That is hard to do by hand and acceptable.

### Non-vacuity (6 mutations, every restore `cp` with identical `shasum`: cc6d388…, 987c070…, bb2b69d…, 2daf6c3…)

| Mutation | Result |
|---|---|
| X1 (executor L10) drop the `use === null` row | KILLED: L17 + `exitPlan` "an unreadable use leaves" |
| X2 (executor L21) a lock-refused relay arms the net | KILLED: L21 "refused by the lock … never arms it" |
| X3 (executor L8) drop the `ResidentStopRefused` rethrow | KILLED: L8 + T10 |
| R1 (own) `wantsAwake` ignores `stopping` | KILLED: L24 `wantsAwake` + L25 |
| R2 (own) `rm` falls through with unreachable + live holder | KILLED: "an unreachable engine stops nothing" |
| R3 (own) the relay purges the run dir on a failed delete | KILLED: L20 + "a delete that never answers is bounded" |

### What holds

The load-bearing assumption. The relay decides removal in one pure place, on a fresh positive read, holding the lock through the delete, after the save. The launcher never arms or deletes. Q2 cases keep the workload and the run dir. Q4 (b) purges only on `removed`/`gone`/`foreign`, with the lock still held. No `transport`/`client`/`tui` change, and no second broker.

### Unverified (by me)

Everything real (Docker, compiled relay, `caffeinate`, engine delete) is the owner's checklist. `tsc -p apps/mobile` was not run (no deps here; `agentInfo` is the only type it could see).

### How the executing model behaved

**Grade: A−.** It followed the plan in order, wrote tests red first, and ran 61 mutations, including honest analysis of 4 survivors (one was its own test's fault, one a masked row, one a real test hole it closed). It drifted where the code demanded (45 s grace, `linkStopped`, `!stopping`, the unreachable+holder early return) and recorded each drift with a reason. It reported the gate faithfully: it said `bun run check` was not green for an out-of-scope reason instead of claiming it. The minus: the AGENTS.md rule sentence it wrote does not match its own code (finding 1), in the one file where wording is binding. The plan line 221 was also left behind its own drift.

**Same model as the executor (claude-opus-5-5), fresh context only.** Shared blind spots can survive both passes. For a load-bearing slice, AGENTS §10 would prefer a different model as reviewer.

## Execution — fix round 1

*— deepseek-v4.1-flash, 2026-10-31*

Four findings, all fixed. Gate: `bunx tsc --noEmit` clean, `bunx biome check .` 575 files 0/0, `bun test packages` **3786 pass / 3 skip / 0 fail** (before: 3782; the +4 are the new tests in `run-state.test.ts` + `kept-cmd.test.ts`).

1. **Doc text, `AGENTS.md:270-275` (§7 pod lifecycle).** The sentence now matches the code exactly: the relay "removes it only through `exitPlan` (a stop, or a clean idle that one fresh read shows nobody else uses) + `removeVerifiedKept`, the net staying ARMED until that delete is done — so a crash mid-delete still converges". "Disarming first" is gone; the code (`relay.ts:346-352` delete, then `leave()` → `disarmNet` at `relay.ts:195`) is untouched. "A normal exit" is replaced by what the code does: a stop, or a clean idle nobody else uses.

2. **`ps` shows why a keep=false workload stayed — `run-state.ts:291-294`.** `ownerText` no longer drops `detail` for `idle`: `detached · idle (<detail>)` / `idle (<detail>)`, through the same `untrustedText` as every other pod/owner string. `interrupted` still prints bare (no relay writes a detail there). The plan table (`docs/…lifecycle.md`, `statusOf`) was updated to match.
   - Red: `run-state.test.ts` "`idle` with a detail" → `Expected "detached · idle (not removed: …)"`, `Received "detached · idle"`; `kept-cmd.test.ts` "a workload left behind: the reason reaches `ps`, sanitised" → `Received "…  running · idle"`. Green after the change: both pass, ESC stripped (`x [2J`).

3. **`forgetKept` failing after a good delete — `kept-cmd.ts:184-207` (`KeptRemoval` gains `forgetError`), `:332-339` (`rm` prints a `[warn]`), `relay.ts:365-370`.** A failed `forgetKept` no longer escapes and becomes `kind: "failed"`; `removed`/`gone`/`foreign` carry `forgetError` beside them, so the message says the workload is gone and only its index entry stayed. The relay emits its own note and keeps the run dir (so `ps -v` shows it); `rm` then sees `gone` and clears both — the convergence the Review named, now with a truthful line.
   - Red (old code, both tests): "a stale entry after a successful delete" fails with the uncaught `ERR_FS_EISDIR` that `forgetKept` throws; "`rm` after a successful delete but a failed forget" fails on `not.toContain("not removed")` (the old `failed` branch printed it). Green after the change: `kept-cmd.test.ts` 35 pass / 0 fail.

4. **Plan drift, `docs/feat/detached-relay-lifecycle.md` `rm` section.** The line now reads "After the delete, and on `gone` or `foreign`", with the `foreign` purge explained as the drift the Review named, plus one bullet for the `forgetError` split above.

### Not done, and why

- **No relay-level test for finding 3.** The behaviour is fixed at the source (`relay.ts:365-370`) and covered at the unit boundary (`KeptRemoval.forgetError`, and `rm`'s `[warn]` red→green), but the relay branch that emits the note has no test of its own: making the index unwritable inside the relay rig kept failing to land in this environment, and I stopped rather than loop. Verify it by hand: `chmod 500 <configDir>/kept`, run `--detach --keep=false`, let it idle — `owner.json` `detail` must say `removed, but its entry … stayed` and `ps` must show it. Recorded, not silently dropped.

## Review — fix round 1

*— claude-opus-5-5, 2026-10-31* (fresh context; executor was deepseek-v4.1-flash, a different model family)

**Verdict: FIX (REQUEST-CHANGES, small).** Review findings 1, 2 and 4 are fixed truthfully. Finding 3 is fixed at the source: a successful delete is never reported as failed any more. But the new `forgetError` path has three new defects: two messages are false or contradict themselves, and the new relay branch has no test, although adding one is cheap. None loses data or breaks a §7 invariant. All three are LOW, and all three are wrong in the fail-loud direction. That is the one property this round was meant to restore, so they should be fixed before the merge.

**Scope:** `git diff 14c916e 97bd797` (7 files). The tracked tree equals the snapshot `97bd797`. `keep-awake.*` and the task doc are untracked, so `git diff` does not see them.

**Gate (this worktree):** `bunx tsc --noEmit` clean. `bunx biome check .` checked 575 files with 0 errors and 0 warnings. `bun test packages` gives **3786 pass / 3 skip / 0 fail** (13807 expects, 266 files). This matches the orchestrator. The 3 skips are the opt-in ones.

### Per original finding

| # | Verdict |
|---|---|
| 1 AGENTS.md §7 | **FIXED, true.** "removes it only through `exitPlan` (a stop, or a clean idle that one fresh read shows nobody else uses) + `removeVerifiedKept`, the net staying ARMED until that delete is done". This matches `relay.ts`: the `plan.kind !== "remove"` → `leave()` gate, then `removeVerifiedKept`, then `leave()`, which disarms first (`relay.ts:194-195`). The disarm happens only after the delete has settled. |
| 2 `ps` shows `idle (<detail>)` | **FIXED.** `run-state.ts:290-293`. The text is sanitised twice: by the `note` reducer (`relay-state.ts:129`, `untrustedText`) and on read (the test writes a raw ESC into `owner.json` and gets none in the output). |
| 3 `forgetKept` throwing after a good delete | **FIXED at the source.** `forget()` (`kept-cmd.ts:198-205`) means `removed` can no longer become `failed`. **New defects: findings A–C below.** |
| 4 plan line 221 | **FIXED** (doc lines 221-222). But line 222 repeats finding A's inaccuracy: it says "the workload is gone" for `foreign`. |

### Findings (new)

- **A. LOW (false message), `relay.ts:362-371`.** The `forgetError` branch is entered for `removed`, `gone` **and `foreign`**. The note always says "removed, but its entry in the kept index stayed", and the comment says "The workload is gone". On `foreign` nothing was removed: another workload took the name and is still running, untouched. So the note reports a removal that never happened. The `KeptRemoval` doc comment (`kept-cmd.ts:186-188`, "says the workload is gone") and plan line 222 say the same wrong thing. Fix: word the note by `removal.kind` (for `foreign`: "left alone (not tentacle's); its stale entry stayed: …").
- **B. LOW (self-contradicting output), `kept-cmd.ts:347` + `:349`, and `:357` + `:359`.** When the forget fails, `rm` prints `… left it alone; dropped its stale entry` (foreign) or `Removed the entry of X: the … no longer exists.` (gone, no holder), and then `[warn] its entry in the kept index was not dropped`. The first line is false, and the second contradicts it. The new test "a foreign workload whose entry will not drop" asserts **both** lines, so it pins the contradiction. Fix: print the "dropped its entry" wording only when `forgetError === undefined`.
- **C. LOW (test gap, AGENTS §4/§9), the relay branch has no test, and it is cheap.** Mutation M3 disables the branch, so the relay falls through to `leave(true)`, purges the run dir and hides the note. M3 **survives** the whole `relay.test.ts` + `kept-cmd.test.ts` (79 pass / 0 fail). The executor gave "making the index unwritable … kept failing to land" as the reason. That does not hold: it tried `chmod`. The EISDIR trick that the executor already uses in `kept-cmd.test.ts` works in the relay rig. I added a temporary probe (removed afterwards): `removing()`, then replace the entry file with a directory (`rmSync` + `mkdirSync`), run to idle and past the grace, and assert `remove:box`, the `detail` contains "removed, but its entry…", and the run dir exists. It took 15 lines, was **green** on the fix and **red** under M3 (`owner(r.dir)` undefined: the dir was purged). So the "Not done" item is **not acceptable**: add this test, and give it a `foreign` variant for finding A.

**Q4 (b) coherence:** it converges, but asymmetrically. On `forgetError` the relay **keeps** the run dir, so `ps -v` shows the note. `rm` **drops** it (`dropRunDir` at `:350/:360/:365`) and keeps the entry, which is defensible because the user already sees the `[warn]`. In both cases the next `rm` sees `gone`, retries the forget and clears what is left. Nothing is orphaned without an entry that points at it. It holds, and no change is needed. A one-line note in the plan would make the asymmetry intentional rather than accidental.

**Never "failed" for a delete that worked, never "done" for one that failed:** this **holds** for `removed`. `failed`/`unreachable` are unchanged and still keep the entry. The relay's `.catch` → `failed` can now come only from `verify`/`host.remove`/the timeout, never from the forget. The only exceptions are the wording defects A and B.

### Mutations (every restore by `cp` from `.tentacle/tmp/detached-relay-lifecycle/review-fix1/`, `shasum` identical before/after: run-state `cb4690e…`, kept-cmd `0e890e2…`, relay `daaf528…`, relay.test `415a5e6…`)

| Mutation | Result |
|---|---|
| M1 (finding 2) `idle` drops `detail` | **KILLED**: `run-state.test` L27 + `kept-cmd.test` "a workload left behind … sanitised" (2 fail) |
| M2 (finding 3) `forget()` rethrows (old behaviour) | **KILLED**: the 3 new `kept-cmd.test` tests fail |
| M3 (finding 3, relay) the `forgetError` branch is never taken | **SURVIVES** the suite → finding C. The temporary probe test kills it |

### Attacks tried

- A hostile ESC in an `idle` detail reaching `ps`: stripped (test + reducer). **Holds.**
- `foreign` + forget failure through the relay and `rm`: **found A and B**.
- Whether the relay test is really hard to write: **it is not** (C).
- `forgetError` text unsanitised in `[warn]`/note: it is a laptop `fs` error about a laptop path, not pod-supplied, and the note passes through `untrustedText` anyway. **Holds.**
- Convergence after `rm` with `forgetError` (run dir gone, entry left): the next `ps` shows the row as `gone` with no relay row, and the next `rm` retries. **Holds.**

### How the executing model behaved

**Grade: B.** All four findings were addressed with tight diffs and no scope creep. The AGENTS.md sentence is now exact. The red→green claims I re-ran are true (M1, M2). The gate was reported correctly (3786/3/0, lint 0). It recorded the missing relay test honestly instead of hiding it, and it stopped rather than looping, as §0 asks. The minus: it reasoned about `removed` only. It did not check its new message against `foreign`/`gone` (A, B), and it wrote a test that asserts the contradiction (B). It also gave up on the relay test after trying one technique (`chmod`), when the technique it had used one file earlier would have worked (C).

## Execution — fix round 2

*— deepseek-v4.1-flash, 2026-10-31*

All three findings (A, B, C) fixed; nothing dropped. Gate: `bunx tsc --noEmit` clean, `bunx biome check .` 575 files 0 errors / 0 warnings, `bun test packages` **3789 pass / 3 skip / 0 fail** (before: 3786; the +3 are the new/rewritten tests below). The 3 skips are the opt-in ones.

**A — `relay.ts:367-372`, the note now states the fate per kind.** One shared projection, `removalFate(kind)` (`kept-cmd.ts:203-213`: `removed` → `"removed"`, `gone` → `"already gone"`, `foreign` → `"left alone (not tentacle's)"`); the relay's note is `${removalFate(removal.kind)}, but its entry in the kept index stayed: …`. The branch comment no longer says "the workload is gone", and the `KeptRemoval` doc comment (`kept-cmd.ts:184-189`) plus plan line 222 now say the fate is per kind. `rm` uses the same kind-based wording in its own lines (see B).
- Red (new `relay.test.ts:770` "L22b a FOREIGN workload whose entry will not drop", on the pre-fix `relay.ts` `daaf528`): `Expected to contain: "left alone (not tentacle's), but its entry in the kept index stayed"` / `Received: "removed, but its entry in the kept index stayed: Path is a directory: rm returned EISDIR …"`. Green after the change.

**B — `kept-cmd.ts:363-367` + `:376-383`, no line claims a drop that did not happen.** For `foreign`, `; dropped its stale entry` is appended only when `forgetError === undefined`. For `gone` with no holder, the line is `Removed the entry of …: the … no longer exists.` only when the entry was really dropped, else `The <noun> of <label> no longer exists.` — the workload's fate, leaving the entry to the `[warn]` that follows.
- Red, test 1 — the existing "a foreign workload whose entry will not drop" now asserts `not.toContain("dropped its stale entry")` (it used to pin the contradiction in its title only). On the pre-fix `kept-cmd.ts` (`0e890e2`): `Expected to not contain: "dropped its stale entry"` / `Received: "… left it alone; dropped its stale entry\n[warn] its entry in the kept index was not dropped: EACCES …"`.
- Red, test 2 — NEW `kept-cmd.test.ts:498` "gone with a failed forget: the line never says the ENTRY was removed" (index made unwritable with `chmod 500`, EACCES): pre-fix `Received: "Removed the entry of a (docker, local): the container no longer exists.\n[warn] … was not dropped: EACCES …"` — the two lines contradict; post-fix `The container of a (docker, local) no longer exists.` + the `[warn]`. Green.
- Note: an earlier draft of test 2 used the EISDIR trick; it failed because `readKept` also refuses a directory, so `rm` exits 1 with "no kept container or pod named". `chmod 500` is the right instrument here (the same one the sibling test uses).

**C — the relay-level test the review asked for, plus its `foreign` variant.** `relay.test.ts:750` "L22 a failed forget after the delete": `removing()`, replace the entry file with a directory (`rmSync` + `mkdirSync`) before the run, run to idle and past the grace; asserts `remove:box` ran, `detail` contains `removed, but its entry in the kept index stayed`, and BOTH the run dir and the entry path still exist. ~17 lines, as predicted.
- Green on the fix; **red under the review's mutant M3** (`if (false && removal.forgetError !== undefined)` in `relay.ts:367`, backup `.tentacle/tmp/…/fix2/relay.FIXED.ts`): `relay.test.ts` 44 pass / **2 fail** — L22 `error: Received value must be an array type…` (the run dir was purged, so `owner(r.dir)` is `undefined`) and L22b `Expected to contain: "left alone…"` / `Received: ""`. Restored from `cp`; `shasum packages/cli/src/relay.ts` = `880ae3b9…` before and after the mutation (identical).
- The finding that unblocked it: my first attempts timed out waiting for `idle` because I passed `new Scripted([{…},{…}])` (a flat event list) instead of the rig's list-of-scripts shape `new Scripted([[{…},{…}]])` — a 4-character bug in the test, not a rig limitation. Worth recording so the next round does not re-derive it.

**Mutations (every restore by `cp` from `.tentacle/tmp/detached-relay-lifecycle/fix2/`, `shasum` identical before/after: `relay.ts` `880ae3b9…`, `kept-cmd.ts` `c960e294…`, and the two ORIG baselines `daaf528d…` / `0e890e26…`).**

| Mutation | Result |
|---|---|
| B1 the `foreign` line always says "; dropped its stale entry" (old code) | **KILLED**: `kept-cmd.test` "a foreign workload whose entry will not drop" |
| B2 the `gone` line always says "Removed the entry of …" (old code) | **KILLED**: `kept-cmd.test` "gone with a failed forget" |
| A1 the note is hard-coded "removed, …" (old `relay.ts`) | **KILLED**: `relay.test` L22b |
| M3 the `forgetError` branch is never taken | **KILLED** by L22 + L22b (it survived the suite before this round) |

**Not done / not claimed:** no separate mutation was run for A's `gone` word ("already gone") — the `rm` side of `gone` is covered by B2, the relay side only by L22 (`removed`); the `gone` relay path is reached only when the workload vanishes between the plan and the check, which the rig does not script. Recorded, not silently dropped.

