# fix/daemon-records-stale — a `serve` stopped by SIGTERM/SIGHUP leaves its daemon record behind

> **Status:** implementation — **APPROVED** (owner delegated the details to the orchestrator, 2026-11-26; decisions under *Orchestrator decisions*)
> **Branch:** `fix/daemon-records-stale`
> **Type:** fix · **Size:** M · **Blast:** cross-module · **Suited:** Sonnet executes; standard Review (not load-bearing: no protocol, no record-format change, no §7 invariant moved — but two packages and the serve's signal path, hence M · cross-module rather than the TODO's S · contained)
> **Changelog:** `changelog.d/daemon-records-stale.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-26*

Owner TUI test, 2026-11-26 ~12:20: an agent listing `~/.config/tentacle/daemons/`
saw THREE records for port 4010, two of them for dead processes, same `serveId`.
A `serve` writes `<configDir>/daemons/<pid>.json` at listen
(`packages/cli/src/serve.ts:1117-1143`) and removes it only inside `stop()`
(`serve.ts:1275`). The CLI calls `stop()` only on **SIGINT**
(`packages/cli/src/main.ts:1294-1305`); there is no SIGTERM/SIGHUP handler
anywhere on the `serve` path (`rg SIGTERM|SIGHUP packages/cli/src` hits only
`pod-resident.ts`, `relay.ts`, `pair`'s exit hooks — never the plain `serve`).
So `pkill -f "tentacle serve"`, `kill <pid>`, a supervisor stop, or closing the
terminal/tmux pane kills it with the default disposition: no `stop()`, so the
record stays — and, worse, the "let the session writes land, release the store
lock" that `stop()` does (`serve.ts:1267-1281`, `release()`) is skipped too.

What the code readers do today (verified, every reader of `daemons/`):
`readDaemonRecords` skips a dead pid (`packages/daemon/src/device-store.ts:1439`)
and, with `freshWithinMs`, a record whose heartbeat mtime is old (`:1443`);
`discovery` (`packages/cli/src/discovery.ts:230-238`), `pair`
(`packages/cli/src/pair.ts:211-214`) and `devices` (`packages/cli/src/devices-cmd.ts:308-311`)
all pass `freshWithinMs: DEFAULT_STALE_AFTER_MS`. Only the discovery POLL deletes
anything (`sweepDeadDaemonRecords`, `discovery.ts:303-308`), and the poller runs
only while a client is subscribed (`discovery.ts:372-383`). `tentacle ps` does not
read `daemons/` at all (it reads the kept index). So the code readers already
HIDE a dead serve; the defect is (1) the writer does not clean up on the
commonest exit paths, and (2) the files are never pruned unless a phone happens
to be subscribed — so anything that looks at the directory itself (the model's
`ls`, a human, a future reader that forgets `freshWithinMs`) sees ghosts. A
record whose pid was REUSED by a stranger is hidden by the heartbeat check but
never deleted until that stranger exits.

**Repro** (2026-11-26, on `main` = this branch's base `aeebbae0`), run as
`bun test .tentacle/tmp/daemon-records-stale/repro.test.ts`: it spawns a real
`bun packages/cli/src/main.ts serve --port <p> --no-relay` with a throwaway
`TENTACLE_CONFIG_DIR` (and `HOME`) and a fresh project dir, waits for
`daemons/<pid>.json`, sends one signal, waits for exit, lists the directory.

```ts
// .tentacle/tmp/daemon-records-stale/repro.test.ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = "/Users/gmeghnag/tentacle/.tentacle/tmp/daemon-records-stale";
const MAIN = "/Users/gmeghnag/tentacle/.tentacle/worktrees/daemon-records-stale/packages/cli/src/main.ts";

async function run(signal: "SIGINT" | "SIGTERM" | "SIGHUP", port: number): Promise<string> {
  const cfg = mkdtempSync(join(HERE, `cfg-${signal}-`));
  const proj = mkdtempSync(join(HERE, `proj-${signal}-`));
  const child = Bun.spawn(["bun", MAIN, "serve", "--port", String(port), "--no-relay"], {
    cwd: proj,
    env: { ...process.env, TENTACLE_CONFIG_DIR: cfg, HOME: cfg },
    stdout: "pipe",
    stderr: "pipe",
  });
  const dir = join(cfg, "daemons");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(existsSync(dir) && readdirSync(dir).length > 0)) {
    await Bun.sleep(50);
  }
  const lines: string[] = [];
  lines.push(`== ${signal}  serve pid=${child.pid} port=${port}`);
  lines.push(`before: ${existsSync(dir) ? readdirSync(dir).join(" ") : "(no dir)"}`);
  child.kill(signal);
  const code = await child.exited;
  lines.push(`exit: code=${code} signalCode=${child.signalCode ?? "-"}`);
  const after = existsSync(dir) ? readdirSync(dir) : [];
  lines.push(`after:  ${after.join(" ") || "(empty)"}`);
  for (const name of after) {
    lines.push(`  ${name}: ${readFileSync(join(dir, name), "utf8")}`);
  }
  let alive = true;
  try {
    process.kill(child.pid, 0);
  } catch {
    alive = false;
  }
  lines.push(`  pid ${child.pid} alive: ${alive}`);
  return lines.join("\n");
}

test("repro", async () => {
  const out = [
    await run("SIGINT", 47311),
    await run("SIGTERM", 47312),
    await run("SIGHUP", 47313),
  ].join("\n");
  console.log(out);
  expect(out.length).toBeGreaterThan(0);
}, 60_000);
```

Output:

```
== SIGINT  serve pid=78382 port=47311
before: 78382.json
exit: code=0 signalCode=-
after:  (empty)
  pid 78382 alive: false
== SIGTERM  serve pid=78383 port=47312
before: 78383.json
exit: code=143 signalCode=SIGTERM
after:  78383.json
  78383.json: {"v":1,"pid":78383,"host":"127.0.0.1","port":47312,"tls":false,"cwd":"/Users/gmeghnag/tentacle/.tentacle/tmp/daemon-records-stale/proj-SIGTERM-oIn7Dh","startedAt":1795691065603,"serveId":"vUUBnBW_IaDLhL3qNtRm3R"}
  pid 78383 alive: false
== SIGHUP  serve pid=78390 port=47313
before: 78390.json
exit: code=129 signalCode=SIGHUP
after:  78390.json
  78390.json: {"v":1,"pid":78390,"host":"127.0.0.1","port":47313,"tls":false,"cwd":"/Users/gmeghnag/tentacle/.tentacle/tmp/daemon-records-stale/proj-SIGHUP-xh6mqN","startedAt":1795691065920,"serveId":"5WdCCyPsxmPsIQddNwhLDF"}
  pid 78390 alive: false
```

SIGINT is clean (exit 0, directory empty); SIGTERM (143) and SIGHUP (129) die by
the signal and leave a record for a dead pid. Same `serveId` across restarts is
expected (it is the project's relay id, `serve.ts:1055`), which is exactly the
owner's "same serveId, dead pids" picture.

Two supporting probes (same folder, 2026-11-26), which the design stands on:

- `exit-hook.test.ts` — which deaths run Bun's `process.on("exit")` listeners
  (child script writes a marker file from its exit listener):
  ```
  process.exit(130): exit=130 signal=- exitListenerRan=true
  uncaught throw: exit=1 signal=- exitListenerRan=true
  unhandled rejection: exit=1 signal=- exitListenerRan=true
  SIGTERM, no handler: exit=143 signal=SIGTERM exitListenerRan=false
  ```
- `starttime.test.ts` — reading ANOTHER pid's start time: `ps -o lstart= -p <pid>`
  costs ~25 ms but its local-time text parsed **one hour off** under the test
  env (`deltaMs: -3599411`): `lstart` is timezone-fragile. `ps` on a gone pid
  exits 1 with empty stdout. ⇒ use `ps -o etime=` (elapsed time, no timezone).

## Implementation

*— claude-opus-5-5, 2026-11-26*

### Load-bearing assumption

**The record is left behind because `serve` never runs `stop()` on SIGTERM/SIGHUP,
and an `exit` listener is the net for every other path we control.** Proven, not
inferred: the repro above (SIGINT clean, SIGTERM/SIGHUP leave the file); the only
handler is `process.on("SIGINT", …)` at `main.ts:1298`; `stop()` is the only
remover (`serve.ts:1275`); and the probe shows Bun runs `exit` listeners on
`process.exit(n)`, on an uncaught throw and on an unhandled rejection, but NOT on
an unhandled signal. SIGKILL / power loss stay uncatchable — that is what the
reader-side prune is for.

### Preconditions

- **Record shape and paths.** `DaemonRecord` (`device-store.ts:1323-1344`), file
  `<configDir>/daemons/<pid>.json` (`:1350-1359`), written atomically (`:1366`,
  `writeAtomic` = rename, so a reader never sees a half file). Unchanged by this fix
  (no `DAEMON_RECORD_VERSION` bump, `:1346`).
- **Remove only our own file.** `removeDaemonRecord(configDir, pid = process.pid)`
  (`:1397-1399`) — a serve can only remove `<its pid>.json`, never a sibling's.
- **Liveness.** `processAlive` (`:518-525`): `kill(pid, 0)`, EPERM counts as alive
  (never delete what we merely cannot signal).
- **Heartbeat.** Every serve with devices + discovery touches its record every
  `DEFAULT_HEARTBEAT_MS` = 10 s (`discovery.ts:57`, `:339-356`, always on `:366-368`);
  `DEFAULT_STALE_AFTER_MS` = 30 s (`:59`) is the freshness horizon all readers use.
  A fresh record is therefore a LIVE serve: a stranger reusing the pid never
  touches it.
- **Stop order.** `stop()` stops discovery (heartbeat) and the relay BEFORE removing
  the record (`serve.ts:1270-1275`), synchronously in one tick — so no heartbeat
  can run between "discovery stopped" and "record removed".
- **Existing exit-listener pattern.** `serve.ts:616-620` registers a synchronous
  `process.on("exit", …)` and removes it in `stop()`, so in-process tests that start
  many daemons do not leak listeners. The record net copies that pattern.
- **Second Ctrl+C contract.** A second SIGINT exits at once (`main.ts:1299-1301`,
  "a hung disk must not trap the user"); kept, extended to every handled signal.
- **Store lock recovers from a dead holder** (`packages/daemon/src/session-persister.ts:686-698`),
  so SIGTERM never blocked a restart — but it skipped `release()` (pending session
  writes). Graceful SIGTERM fixes that as a side effect.
- **Existing in-process test drives SIGINT via `process.emit`**
  (`packages/cli/test/output-streams.test.ts:210-237`): the wiring must keep
  listening on the real `process` by default.

### Design

**A. Writer: every exit path we control removes the record.**

1. *New pure module* `packages/cli/src/serve-signals.ts`:
   - `SERVE_STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const`.
   - `shutdownStep(state: { stopping: boolean }, signal): { kind: "stop" } | { kind: "exit"; code: number }`
     — first handled signal → `stop`; any later one → `exit` with `128 + signum`
     (SIGHUP 1 → 129, SIGINT 2 → 130, SIGTERM 15 → 143). The decision, tested alone.
   - `awaitServeShutdown(host: SignalHost, stop: () => Promise<void>): { done: Promise<void>; dispose(): void }`
     where `SignalHost = Pick<NodeJS.Process, "on" | "off" | "exit">` (default
     `process`). Installs one listener per signal; on `stop` calls `stop()` once and
     resolves `done` whether it resolves or rejects; on `exit` calls `host.exit(code)`.
     `dispose()` removes exactly its own listeners (never `removeAllListeners`).
2. `main.ts:1294-1305` → `const shutdown = awaitServeShutdown(process, () => server.stop()); await shutdown.done; shutdown.dispose(); return 0;`
   — SIGTERM/SIGHUP now take the same graceful path as SIGINT (record removed,
   session writes land, store lock released), and the listener leak is gone.
3. `serve.ts`, right after a successful `writeDaemonRecord` (`:1138`): register
   `const exitRecord = () => removeDaemonRecord(devices.configDir)` on
   `process.on("exit")`; in `stop()` remove the record (as today) then
   `process.off("exit", exitRecord)`. Covers the second-signal `process.exit(13x)`,
   an uncaught throw, an unhandled rejection, and any other `process.exit` while the
   daemon is up. Synchronous `rmSync` — legal in an exit listener.

**B. Readers prune — dead pids, and provably reused pids, never a live serve.**

4. `device-store.ts` — extend `sweepDeadDaemonRecords` (`:1519-1548`), name kept:
   options gain `freshWithinMs?`, `now?`, `startedAtOf?: (pid) => number | undefined`.
   A file is removed when:
   - its pid is dead (unchanged), **or**
   - `freshWithinMs` is given, its pid is alive, its mtime is NOT fresh, it parses
     as a v1 record whose `pid` matches the name, and `startedAtOf(pid)` returns a
     start time **later than `record.startedAt + REUSE_TOLERANCE_MS` (60 s)**: that
     process started after the record was written, so it cannot be the writer.
     `undefined` (ps failed, unparsable) ⇒ keep. Malformed / unknown-version file
     with a live pid ⇒ keep (not provable; readers already ignore it).
   - **TOCTOU guard:** immediately before `rmSync`, re-`stat` the file; if its
     `mtimeMs` or `ino` changed since the first stat (a new serve with that pid just
     wrote or touched it), skip.
5. `device-store.ts` — new `processStartedAt(pid, now = Date.now()): number | undefined`
   beside `processAlive` (`:518`): `Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } })`;
   non-zero exit or unparsable ⇒ `undefined`; else `now - parseEtime(text) * 1000`.
   `parseEtime` is pure and exported: `[[dd-]hh:]mm:ss` → seconds, anything else
   ⇒ `undefined`. (Not `lstart`: timezone-fragile, measured above.)
6. Call sites (one rule, every reader):
   - `serve.ts`, before `writeDaemonRecord` (`:1138`): `sweepDeadDaemonRecords(devices.configDir, { freshWithinMs: DEFAULT_STALE_AFTER_MS })`
     in a `try` (housekeeping, never fatal) — every serve start cleans up. (Import
     the constant from `./discovery.ts`, which already owns it.)
   - `discovery.ts:304`: pass `freshWithinMs: afterSleep ? undefined : staleAfterMs`
     and `now: at` — the dead-pid sweep stays every poll; the reuse proof is skipped
     on the waking poll after a suspend (F3), where every mtime looks old. (The
     start-time proof would still keep a real sibling — its start is before its
     `startedAt` — but skipping avoids a `ps` per sibling on wake.)
   - `pair.ts:209-217` (`pairTargetOf`) and `devices-cmd.ts:306-314`: call the sweep
     with the SAME injected `alive` and `freshWithinMs: DEFAULT_STALE_AFTER_MS`
     before `readDaemonRecords`, in the existing `try`.
   - `readDaemonRecords` stays side-effect free (tests call it with fake `alive`).
7. **Self-heal (belt and braces for "never lose a live serve's record").**
   `discovery.ts` heartbeat (`:352-355`): when `touch` returns `false` (file gone)
   and the driver is not stopped, call an injectable `rewrite` (default
   `(dir, self) => writeDaemonRecord(dir, self)`) once; log only if that fails too.
   `stop()` stops the heartbeat before `removeDaemonRecord` in the same tick
   (`serve.ts:1271`/`:1275`), so a heal can never resurrect a stopping serve's
   record; the F4 comment on `touchDaemonRecord` (`device-store.ts:1494-1500`,
   "must never CREATE one") is updated: touch still never creates — the driver
   does, only while running.

#### Orchestrator decisions

(Owner delegated the details, 2026-11-26. Recommended option taken in each.)

- **D1 — exit code after a graceful SIGTERM/SIGHUP stop: `0`** (as SIGINT today).
  Alternative: re-raise / 128+n. Rejected: the stop completed cleanly; supervisors
  (launchd, systemd) treat 0 as a clean stop. A *second* signal still exits 128+n.
- **D2 — SIGHUP = graceful stop.** Its default today is death without cleanup, so
  handling it only makes that death clean (closing the terminal/tmux pane, the
  owner's case). Caveat accepted: installing a handler overrides an inherited
  `SIG_IGN`, so `nohup tentacle serve` now STOPS on hangup instead of surviving.
  The supported background forms are tmux/screen, `setsid`, launchd/systemd (no
  controlling terminal ⇒ no SIGHUP). Named in the changelog bullet. Rejected
  alternative: leave SIGHUP unhandled — keeps the bug for the commonest
  interactive stop.
- **D3 — pid-reuse proof = process start time via `ps -o etime=`, only for a
  record that is not fresh, with 60 s tolerance, unknown ⇒ keep.** Rejected:
  `lstart` (timezone-fragile, measured 1 h off); a port/`serveId` liveness probe
  (async network inside a sync reader, and a busy or suspended serve that misses a
  probe would be DELETED — the one outcome the task forbids); `comm` name match
  (a reused pid can be another tentacle).
- **D4 — self-heal on heartbeat: yes** (design 7). It turns "never delete a live
  serve's record" from "almost never" (the sweep's guards) into "and if it ever
  happens, it is back within one heartbeat".
- **D5 — prune in the existing sweep, called by every reader;
  `readDaemonRecords` stays pure-ish** (read-only). One rule, one function.
- **D6 — uncaught error: the exit listener removes the record only** (no async
  `stop()` from an exit listener — it cannot await). Session writes in flight at a
  crash are not this task's (pre-existing; see Notes/debt).

### Files

In dependency order (no protocol change):

1. `packages/daemon/src/device-store.ts` — `parseEtime`, `processStartedAt`,
   `REUSE_TOLERANCE_MS`; `sweepDeadDaemonRecords` gains the reuse branch + TOCTOU
   re-stat; doc comments on `DaemonRecord`/`touchDaemonRecord`/sweep updated.
   The package index re-exports the module whole (`packages/daemon/src/index.ts:11`,
   `export * from "./device-store.ts"`), so the new names need no index edit.
2. `packages/cli/src/serve-signals.ts` — **new**, pure (`shutdownStep`,
   `awaitServeShutdown`, `SERVE_STOP_SIGNALS`).
3. `packages/cli/src/serve.ts` — start sweep before the write (`:1138`), exit-listener
   net after it, `off` in `stop()` (`:1275`).
4. `packages/cli/src/discovery.ts` — sweep options at `:304`; heartbeat heal +
   `rewrite` seam at `:352`.
5. `packages/cli/src/pair.ts` (`:209-217`), `packages/cli/src/devices-cmd.ts`
   (`:306-314`) — sweep before read.
6. `packages/cli/src/main.ts` (`:1294-1305`) — use `awaitServeShutdown`.
7. `changelog.d/daemon-records-stale.fixed.md` — one bullet:
   `- **A \`serve\` stopped with SIGTERM or SIGHUP now shuts down cleanly.** \`kill\`, \`pkill\` or closing its terminal used to kill it outright, leaving a stale entry under \`daemons/\` and skipping the final session save; it now stops like Ctrl+C, and stale entries left by a crash or a reused pid are cleaned up. A \`serve\` started under \`nohup\` now stops on hangup — use tmux, \`setsid\` or a service manager to keep it running.`

### Failure modes

| # | Case | How it converges |
|---|------|------------------|
| F1 | SIGTERM / SIGHUP / SIGINT | graceful `stop()`: record removed, writes land, lock released, exit 0 |
| F2 | second signal during a hung stop | `exit(128+n)` → exit listener removes the record synchronously |
| F3 | uncaught throw / unhandled rejection | exit listener removes the record (probe: listeners run, exit 1) |
| F4 | SIGKILL, power loss, OOM kill | record stays; next serve start / `pair` / `devices` / discovery poll deletes it (dead pid) |
| F5 | stale record, pid reused by a stranger | hidden by freshness (today); deleted by the next sweep once `etime` proves the holder started > 60 s after `startedAt` |
| F6 | live serve, heartbeat late (busy, host suspended) | its process start ≤ its `startedAt` ⇒ kept; after a suspend, discovery skips the reuse proof on the waking poll |
| F7 | wall-clock stepped forward > 60 s while a serve runs AND its heartbeat is late | the proof could misfire and delete a live record → heartbeat heal rewrites it within 10 s; readers' freshness hid it anyway until its next beat |
| F8 | `ps` missing / fails / odd output | `undefined` ⇒ keep (dead pids still swept). A live-pid stale record then costs one `ps` per sweep — only while it stays stale |
| F9 | race: sweeper decides "reused", the new holder (a serve with that pid) writes its record before `rm` | TOCTOU re-stat (mtime/ino changed) ⇒ skip; residual microsecond window ⇒ heal (D4) |
| F10 | concurrent serves in one config dir | each removes only `<own pid>.json`; sweeps never touch a fresh record; two sweepers on one dead file: `rm --force` is idempotent |
| F11 | the starting serve's own pid has a stale record (reuse of its own pid) | start sweep may delete it (start > old `startedAt`), then the write recreates it; or the write overwrites it — same end state |
| F12 | in-process tests starting many daemons | exit listener `off` in `stop()`; signal listeners disposed by `awaitServeShutdown` (the old SIGINT listener leaked) |
| F13 | `nohup` users | stop on hangup now (D2) — documented, not silent |
| F14 | unreadable `daemons/` | sweep returns 0 as today; readers return `[]` as today |

### Tests

Red first on this branch's base, then green; each pins the exact property.

1. **E2E red (the bug itself)** — `packages/cli/test/serve-signal-record.test.ts`
   (new): spawn `bun packages/cli/src/main.ts serve --port 0 --no-relay` with a
   temp `TENTACLE_CONFIG_DIR` + `HOME`, cwd a temp project; `untilAsync` the record
   exists (port 0: the OS picks, no probe-then-reuse, §9); send SIGTERM ⇒ assert
   exit code **0** and `daemons/` **empty**. Same for SIGHUP. Red today: 143/129 +
   file left (the repro). Keep its timeout small; it is ~0.5 s per case.
2. **Exit-listener net red** — same file: a child script (in the test's temp dir)
   that imports `startDaemon` by absolute path, starts it on port 0 with
   `relay: { noRelay: true }`, waits for the record, then throws. Assert exit 1
   and no record. Red today (no net).
3. **Pure signal logic** — `packages/cli/test/serve-signals.test.ts` (new), fake
   `SignalHost` (an `EventEmitter` + `exit` spy): SIGTERM ⇒ `stop` once, `done`
   resolves; second SIGINT ⇒ `exit(130)`; SIGHUP then SIGTERM ⇒ `exit(143)`;
   `stop` rejecting ⇒ `done` still resolves; `dispose()` leaves 0 listeners per
   signal and does not remove a foreign listener. `shutdownStep` table-tested.
4. **Sweep** — `packages/daemon/test/device-store.test.ts`, fakes for `alive`,
   `startedAtOf`, `now` (set mtimes with `utimesSync`):
   (a) dead pid ⇒ removed (exists); (b) alive + fresh ⇒ kept and `startedAtOf`
   **never called**; (c) alive + stale + start = `startedAt + 61 s` ⇒ removed
   (**red today**); (d) alive + stale + start = `startedAt + 59 s` ⇒ kept;
   (e) `startedAtOf` → `undefined` ⇒ kept; (f) `startedAtOf` fake that REWRITES the
   file as a side effect ⇒ kept (TOCTOU); (g) live pid, malformed JSON ⇒ kept;
   (h) no `freshWithinMs` ⇒ old behaviour (live pid always kept).
5. **`parseEtime`** — `"05:31"`→331, `"1:02:03"`→3723, `"2-01:02:03"`→176523,
   `"  00:07\n"`→7, `""`/`"abc"`/`"1:2:3:4"` ⇒ `undefined`.
6. **Readers prune** — `pair.test.ts`: plant a record, `alive: () => false`, call
   `pairTargetOf` ⇒ file gone (**red today**). Same for `devicesCommand`
   (`devices-projects.test.ts` style, `deps.alive`). `startDaemon` start sweep:
   plant a record for a REALLY dead pid (spawn `true`, await exit), start the
   daemon (existing `serve-devices` harness) ⇒ planted file gone, own file present.
7. **Heal** — `discovery.test.ts` with fake timers: `touch` → `false`, `rewrite`
   spy ⇒ called with `self` on the beat; after `stop()` no further `rewrite`.
8. **Non-vacuity by mutation** (§9), record in Execution: drop `"SIGTERM"` from
   `SERVE_STOP_SIGNALS` ⇒ test 1 red; remove the tolerance (`>` `startedAt`) ⇒ 4(d)
   red; remove the TOCTOU re-stat ⇒ 4(f) red; delete the `process.on("exit")`
   line ⇒ test 2 red.

Gate: `bun run check` (typecheck → lint → parallel tests) green, lint baseline 0/0.

#### Notes / debt (deliberately left)

- An uncaught error still skips the session-write flush (`release()` is async; an
  exit listener cannot await). Pre-existing; a crash-safe flush is its own task.
- The store lock (`session-persister.ts:686-698`) trusts a live pid without a
  start-time check: a reused pid would block a restart with a clear message
  naming the file. Not seen; same `processStartedAt` could fix it later.
- Records on a config dir shared across hosts (NFS home) are swept by pid on the
  wrong host's pid namespace — pre-existing (the discovery sweep already did it).

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Load-bearing check (before any edit):** `repro.test.ts` re-run on this branch
(code = base): SIGINT exit 0, directory empty; SIGTERM `code=143` and SIGHUP
`code=129`, `<pid>.json` left behind. Holds.

**As built, in order** (each test red on the old code before its change, except
as noted):

1. `device-store.ts` — `parseEtime`, `processStartedAt`, `REUSE_TOLERANCE_MS`,
   the sweep's reuse branch (`pidReused`, re-stat last). Red: 4(c) (`0` for `1`)
   and 4(f). 4(a/b/d/e/g/h) pass on old code by nature (it never deleted a live
   pid); the mutations below cover (d) and (f).
2. `serve-signals.ts` (new) + `main.ts` wiring. E2E red: `code 143/129`, file
   left; crash case: file left. SIGINT passed (control).
3. `serve.ts` — start sweep, exit-listener net, `off` in `stop()`.
4. `discovery.ts` — sweep options, heartbeat heal + `rewrite` seam. Red: all
   three new driver tests.
5. `pair.ts`, `devices-cmd.ts` — sweep before read. Red: both new tests.
6. Changelog fragment. No protocol or schema change.

**Drift from Implementation:**

- `awaitServeShutdown` takes `host` with no default: Biome rejects a default
  parameter before a required one. `main.ts` passes `process`.
- `main.ts` installs the handlers right after `startDaemon` resolves, **before**
  the listening line (not at the old spot after the notices), so whoever waits
  for that line can signal at once. For the same reason E2E test 1 waits for the
  line, not for the record (which is written earlier: signalling on it would
  race the handlers).
- The exit listener is registered even when the first write failed (the
  heartbeat heal may create the record later).
- `readDaemonRecords`' validation moved to `parseDaemonRecord`, shared with the
  reuse proof (no behaviour change).
- The sweep's default `startedAtOf` uses the real clock, not the injected `now`
  (`ps` elapsed time is relative to it).
- Existing F4 log test now injects a failing `rewrite` (a succeeding heal logs
  nothing). Extra tests: SIGINT E2E, (f2) touched-during-proof, default heal,
  reuse proof skipped on the waking poll, real `processStartedAt`. The start
  sweep + `off` test is in `serve-devices.test.ts`.

**Mutations** (each applied, run, reverted):

| mutation | result |
|---|---|
| drop `"SIGTERM"` from `SERVE_STOP_SIGNALS` | E2E SIGTERM fail (`code 143`), 3 pass / 1 fail |
| remove the tolerance | 4(d) fail, 43/1 |
| remove the TOCTOU re-stat comparison | 4(f) and (f2) fail, 42/2 |
| delete `process.on("exit", exitRecord)` | E2E crash case fail, 3/1 |
| remove the start sweep | serve-devices sweep test fail, 8/1 |
| remove `process.off("exit", …)` | serve-devices sweep test fail |
| apply the reuse proof on the waking poll | discovery F3 test fail (this and the row above in one run: 34/2) |

**After the fix**, same repro: SIGINT, SIGTERM and SIGHUP each `code=0
signalCode=-`, `after: (empty)`.

**Tests:** serve*/pair*/devices*/discovery/output-streams/device-store and the
other `startDaemon` users: `491 pass, 0 fail, 41 files`; after a last
typing-only edit to the E2E test, the two signal files: `17 pass, 0 fail`.
Biome on the touched files: clean. **Not run here:** `bun run check` (whole-repo
typecheck, lint, full suite) — the orchestrator's script runs that gate.

**Left open:** a signal landing after the record is written but before
`startDaemon` resolves still kills by default; the next sweep removes the record.

## Review

*— <model-id>, <YYYY-MM-DD>*
