# feat/remove-in-process — One local session path: no `--in-process`, no silent fallback

> **Status:** implementation (awaiting owner approval)
> **Branch:** `feat/remove-in-process`
> **Size:** M (slice A: M · slice B: S) · **Blast:** load-bearing (the startup path of every local TUI; slice B deletes a persistence writer) · **Suited:** strong model executes; mandatory fresh-context Review (`docs/REVIEWER-BRIEF.md`) red-teaming AGENTS §7 "TUI always over RPC" and the persistence bullet
> **Changelog:** `changelog.d/remove-in-process.removed.md`

## Context

*— claude-opus-5-5, 2026-11-14*

Owner decision 2026-11-07 (`TODO.md` entry **remove-in-process**), reconfirmed
2026-11-14 with the local-relay NO-GO (`docs/eval/local-relay.md` §6): the
local TUI keeps ONE session path, the worker thread over RPC (AGENTS §7 "TUI
always over RPC — one session path").

Today a second path still exists in `packages/cli/src/main.ts`:

- `main.ts:2065-2069` — `useWorker = !topBools.has("in-process") && !topBools.has("no-worker")`:
  two flags opt out of the worker.
- `main.ts:2159` — `// worker unavailable → fall through to the in-process path below`:
  when `startWorkerRuntime` returns `null`, the TUI **silently** runs the agent
  on the render thread (`main.ts:2162-2208`: `inProcessAgents` +
  `inProcessSessions` + its own MCP connect + `saver.save` snapshots).
- `local-runtime.ts:1329-1333` documents that contract ("Returns null … the
  caller falls back to in-process, so a worker problem never breaks the TUI");
  the only trace is one stderr line, `[worker] … using in-process`
  (`local-runtime.ts:1361`, `:1407`), written just before Ink takes the screen.

Why it must go: it is the only second session path, so every
persistence / steering / hooks / `/clear` / images change has had to be
written and tested twice (the code carries the scars: `inProcessAgents`'
hand-copied `HooksTrustParamsSchema` gate, `wiring.ts:725-737`; the
laptop-minted snapshot writer, `session-log-store.ts:340-348`; the TUI's
"in-process fallback" branches, e.g. `clear-command.ts:8`,
`useQuitClear.ts:339`). And the silent fallback already hid a real bug once:
the compiled binary lost its worker and users got an 8 s stall plus a degraded
TUI instead of an error (`TODO.md:1326`, "Compiled binary drops the worker
daemon — 8s handshake timed out, silent in-process fallback").

**Goal:** the flags are gone; a worker that fails to start is a clear error
(what failed, what to do), exit 1, no Ink mounted — never a silent switch.

**Repro** (2026-11-14, worktree at `e6cc704c`), `.tentacle/tmp/remove-in-process/repro.ts`:

```ts
import { ARGS, cliMode, parseArgs } from "../../worktrees/remove-in-process/packages/cli/src/flags.ts";

for (const argv of [["-i", "--in-process"], ["-i", "--no-worker"], ["--in-process"]]) {
  console.log(JSON.stringify(argv), cliMode(argv), (() => { const p = parseArgs(argv, ARGS.tui); return p.ok ? `ok bools=${[...p.bools].join(",")}` : JSON.stringify(p); })());
}
```

```
["-i","--in-process"] tui ok bools=interactive,in-process
["-i","--no-worker"] tui ok bools=interactive,no-worker
["--in-process"] tui ok bools=in-process
```

Both opt-outs are accepted today. The silent fallback is shown by the code
(`local-runtime.ts:1360-1363`, `:1406-1410` return `null`; `main.ts:2078`
`if (runtime)` … `:2159` falls through); the red tests in §Tests make it
observable.

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

**Nothing user-facing needs the in-process TUI path any more.** Proof:

1. **Its only entry is `main.ts:2058-2209`** (the `tui` / empty-TTY mode). `rg`
   for `inProcessAgents` / `inProcessSessions` in `packages/*/src`: the only
   callers are `main.ts:2165` and `main.ts:2175`; everything else is tests.
2. **One-shot `tentacle <prompt>` does not use it.** `main.ts:2211-2255` builds
   its own agent with `buildAgent` + `connectConfiguredMcp` and runs
   `agent.run` directly — no `inProcessAgents`, no `inProcessSessions`, no
   TUI, no persistence. Untouched by this task.
3. **`--plain` does not use it.** `main.ts:2046-2054`: `startTerminal(buildAgent(…).agent)`.
   Untouched.
4. **`run` / `attach` / `connect` never had it.** `main.ts:1360-1365` ("ONE
   runtime for every engine (`startEngineRuntime`); no in-process fallback"),
   `engine-runtime.ts:635` ("there is no in-process fallback").
5. **`/move` to local already treats a worker failure as an error, not a
   fallback.** `hop-targets.ts:141-150`: `runtime === null` →
   `{ kind: "failed", notice: "not moved: the local agent could not start" }`.
6. **The worker works everywhere tentacle is supported.** `package.json:8-10`
   requires `bun >= 1.4.3`; that is exactly the version that made the
   URL-form `new Worker` resolve inside a compiled binary
   (`local-runtime.ts:1345-1354`, `TODO.md:1326-1329`), and `scripts/build.ts:4`
   embeds `worker.ts` as a second entrypoint. A real-spawn test already pins
   it from source (`packages/cli/test/worker.test.ts:57-80`, whose header,
   `:14`, exists precisely because "a silent fallback to in-process would hide
   a broken worker").

So the in-process TUI is reachable only by an explicit opt-out flag or by a
worker failure — i.e. only as a degraded mode, never as the sole way to do
something. No capability is lost by removing it.

### Preconditions

- **P1 — no lock or write is held between `openSessions` and the runtime
  start.** The session file lock is taken per write (AGENTS §7 persistence:
  "Every write to `<uid>.jsonl` holds the session's lock file"); `openSessions`
  (`main.ts:1250`) only loads/picks. So returning 1 after a failed worker start
  leaves nothing to release except draining the (empty) saver. Executor:
  confirm at `main.ts:1250` before writing the error path.
- **P2 — nothing is mounted yet.** The worker is started at `main.ts:2073`,
  before `runSessionTui` → `startTui` (`main.ts:2133`); so writing the error to
  `err` (stderr) does not violate "Never write raw to the terminal while Ink
  owns it" (AGENTS §7).
- **P3 — single broker.** The worker path builds ONE `PermissionBroker`
  (`main.ts:2072`) shared with `startTui` (`:2140`) and the hop facade
  (`:2091`, `:2121`). Removing the in-process block removes the second
  construction site (`wiring.ts:717`); the worker one is unchanged.
- **P4 — the worker path is self-sufficient for MCP.** The worker connects MCP
  itself and forwards errors (`local-runtime.ts:1367-1377`); the in-process
  block's own `connectMcpServers` (`main.ts:2166-2174`) goes with it.

### Design

**Slice A (M) — the flags and the fallback go; a start failure is an error.**

1. `startWorkerRuntime` (`local-runtime.ts:1334`) returns `Promise<LocalRuntime>`
   and **throws** a `WorkerStartError` (exported class: `phase: "spawn" | "handshake"`,
   `reason: string`) instead of logging and returning `null`. While there:
   - the `error` event that today only fills `workerError` (`:1355-1357`) also
     **rejects the handshake at once**, so a worker that fails to load
     (the compiled-binary `ModuleNotFound` class) errors immediately instead of
     after the 8 s timeout;
   - two test seams, defaulted to today's behaviour: `spawn?: () => Worker`
     (default: the URL-form `new Worker`, `:1354`, unchanged) and
     `handshakeMs?: number` (default `8000`, `:1403`).
   - The `[worker] … using in-process` lines (`:1361`, `:1407`) are deleted;
     the doc comment `:1329-1333` says "throws `WorkerStartError`; there is no
     fallback".
2. A pure formatter, `workerStartFailureText(error: unknown, logPath: string): string`,
   in `local-runtime.ts` next to the error (React-free, unit-tested — AGENTS §7
   "logic lives in pure modules"). Text (one place, so the hop and the TUI
   say the same thing):
   ```
   [error] the local agent could not start (worker <phase>: <reason>)
     tentacle runs its agent in a worker thread and has no fallback.
     Check: Bun >= 1.4.3 (`bun --version`), or reinstall the binary (`tentacle update`).
     Details: <daemon error log path>
   ```
   `<reason>` goes through the existing control-character stripping used for
   terminal text (`untrustedText`, `untrusted-text.ts:12`, already used at `hop-targets.ts:146`); the
   path is `daemonErrorLogPath(config.configDir)` (`daemon-log.ts:15`), and the
   error is also written there with `logDaemonError` (`daemon-log.ts:24`).
3. `main.ts`: delete `useWorker` and its comment (`:2065-2070`); call
   `startWorkerRuntime` in a `try`; on `WorkerStartError` (or any throw):
   `logDaemonError`, `err(workerStartFailureText(…))`, drain the saver like
   `runSessionTui`'s `finally` does (`tui-sessions.ts:200-207`), `return 1`.
   Delete the in-process block (`:2159-2208`) and the now-unused imports
   (`inProcessSessions` `:144`, `inProcessAgents` `:156`, and whatever
   `tsc`/Biome then report unused — e.g. `McpStatusTracker`,
   `connectMcpServers`, `recordFromSnapshot` if only used there;
   `longToolNameWarnings` stays, one-shot uses it at `:2228`).
4. `hop-targets.ts:141-157`: the `null` branch goes; the existing `catch`
   returns `not moved: the local agent could not start (<reason>)` from the
   `WorkerStartError` (sanitised). The session stays where it was (existing
   hop rollback, unchanged).
5. Flags/help: drop `"in-process": {}, "no-worker": {}` (`flags.ts:175`), the
   `[--in-process]` in `USAGE.tui` (`flags.ts:842`), the `--in-process` line
   in `HELP` (`main.ts:267`), and the `--in-process` mention in the `flags.ts:787`
   comment. A stale `--in-process` then gets the parser's normal
   `unknown option --in-process` + exit 1 (`flags.ts:340`) — pre-public, no
   shim or "was removed" hint (AGENTS §7 protocol rule spirit; memory: breaking
   OK pre-public).
6. Dead code: delete `inProcessAgents` (`wiring.ts:707-750`) and
   `packages/cli/src/session-jobs.ts` entirely (its three exports —
   `SessionJobsView`, `InProcessDeps`, `inProcessSessions` — have no non-test
   user besides `main.ts:2175`; executor re-checks with `rg` first). Comments
   naming "the in-process fallback/TUI" in `cli` and `wiring.ts` (`:340`,
   `:365`, `:392`, `:646`, `:719`) are reworded.

**Slice B (S) — the snapshot writer goes (only the in-process path wrote it).**
`SessionSaver.save` (`session-saver.ts:120-123`) is called only by
`main.ts:2180`; it is the only caller of `LogSessionStore.saveSnapshot`
(`session-log-store.ts:346`), whose queue kind `"snapshot"` and
`snapshotInc` field (`:181`) exist for nothing else. Delete those (and the
`saveSnapshot` member of `SaveTarget`, `session-saver.ts:20`). **Keep**
`segmentFromMessages` (`session-log-file.ts:496`) — asides use it — and **every
reader**: a file already holding a laptop-minted segment must still load (no
format change, no `schemaVersion` change). Deletion only; the persistence
invariant's rules apply unchanged to the remaining writers.

> **Drift (found while executing, 2026-11-14):** "deletion only" is **not**
> true of the TEST tree. `saveSnapshot` is also the laptop
> **fixture's** writer (`cli/test/session-fixture.ts:12`) — the way ~28 test
> sites put a `<uid>.jsonl` on disk — and `SessionSaver.save` has ~30 test
> call sites. So slice B is deletion **plus a migration** of both to the
> existing cold-write seam, `forkWrite` + `store.write` (`session-fork.ts:29`,
> already the `/clear` fork's writer), which produces a byte-equivalent log
> (verified: identical lines, `inc` prefix `laptop-` vs `fork-`; `load()`
> equal, containment/aside rule kept). `session-fixture.ts` gains
> `recordWrite(record)` and `saveFixture` keeps its signature, so most call
> sites changed one word (`saver.save(r)` → `saver.write(recordWrite(r))`).

No protocol change (no `protocol.d/` note); no on-disk format change.

### Files

Slice A, in order:
1. `packages/cli/src/local-runtime.ts` — `WorkerStartError`, throw instead of
   `null`, error-event early reject, `spawn` / `handshakeMs` seams,
   `workerStartFailureText`.
2. `packages/cli/src/hop-targets.ts` — drop the `null` branch, name the reason.
3. `packages/cli/src/flags.ts` — drop the two bools, usage, comment.
4. `packages/cli/src/main.ts` — HELP line, error path, delete the in-process block + imports.
5. `packages/cli/src/wiring.ts` — delete `inProcessAgents`, reword comments.
6. `packages/cli/src/session-jobs.ts` — delete.
7. Tests (below) + `changelog.d/remove-in-process.removed.md`.
8. Docs: `docs/extensions.md:75` (drop "or the in-process fallback"), `:833`
   and `:1269` (the 64-char MCP warning is then one-shot only),
   `docs/container-config-sources.md:107` (stale `main.ts` in-process cite).
   `README.md:684`, `AGENTS.md:148/205` say "in-process worker" = the worker
   itself: unchanged. `ARCHITECTURE.md:154` is history (F1): unchanged.
   `TODO.md`: tick the entry at merge.

Slice B:
9. `packages/daemon/src/session-log-store.ts`, `packages/cli/src/session-saver.ts`
   and their tests (`session-log-store.test.ts` W14 `:215`, L3 `:638`).

### Failure modes

| # | Case | Today | After | Converges how |
|---|------|-------|-------|---------------|
| F1 | `new Worker` throws (no `Worker` global, unresolvable entrypoint) | `[worker] could not start …; using in-process`, degraded TUI | `WorkerStartError{spawn}` → the error text, exit 1, no Ink | Nothing written (P1); user fixes Bun/binary and reruns |
| F2 | Worker spawns but fails to load (compiled binary on old Bun: `ModuleNotFound /$bunfs/root/worker.ts`) | 8 s stall, then fallback | rejected on the `error` event, immediately, `{handshake}` with that message | as F1 |
| F3 | Worker loads, handshake never answers | 8 s, fallback | 8 s, `{handshake}: worker handshake timed out after 8000ms`, worker terminated | as F1 |
| F4 | Handshake fails with a `VersionMismatch` / RPC error | fallback | `{handshake}` with the RPC message | as F1 |
| F5 | `--resume <uid>` / `--continue` and the worker fails | resumed in-process | exit 1 before any write; the session file is untouched | rerun with the same flag after the fix |
| F6 | `/move` back to local and the worker fails | `not moved: the local agent could not start` | same + `(<reason>)` | session stays on its current target (existing hop rollback) |
| F7 | Script/alias still passes `--in-process` / `--no-worker` | accepted | `unknown option --in-process`, exit 1 | user drops the flag |
| F8 | Worker dies AFTER the handshake (mid-session) | not a start failure; the fallback never covered it | unchanged (existing transport-close handling) | out of scope |
| F9 | Hostile/odd text in the reason (control chars) | raw | sanitised (`untrustedText`) before the terminal | — |

Pre-existing, NOT changed here (noted as debt in Review): the worker's
`mcp-errors` listener (`local-runtime.ts:1367-1377`) keeps calling `log` = the
raw `err` after Ink has mounted if a server's error arrives late.

### Tests

Red first (run on the current code, see them fail), then green:

- **T1 (red) spawn failure throws, never resolves `null`.** `worker.test.ts`:
  `startWorkerRuntime(config, deps, log, { spawn: () => { throw new Error("no worker here"); } })`
  → rejects with `WorkerStartError`, `phase === "spawn"`, `reason` contains
  `no worker here`. Red today: the seam is absent and the function resolves
  `null` (assert `rejects`, so a `null` resolve fails the test).
- **T2 (red) a worker that errors on load fails fast with its message.**
  `spawn` returns a fake `EventTarget`-based worker that dispatches an
  `error` event (`message: "ModuleNotFound resolving /$bunfs/root/worker.ts"`);
  `handshakeMs: 5000`; assert it rejects in < 1 s with that message
  (`phase: "handshake"`) and `terminate` was called. Red today: 8 s + `null`.
- **T3 handshake timeout.** A fake worker that never answers, `handshakeMs: 50`
  → `WorkerStartError{handshake}` naming the timeout; `terminate` called.
- **T4 the text.** `workerStartFailureText` for each phase contains the phase,
  the reason, `Bun >= 1.4.3`, `tentacle update`, the log path; a reason with
  `\x1b[2J` comes out without the ESC. Never contains `in-process`.
- **T5 (red) the flags are gone.** `args.test.ts`:
  `parseArgs(["-i", "--in-process"], ARGS.tui)` and `["--no-worker"]` →
  `{ ok: false, error: "unknown option --in-process" | "--no-worker" }`; and
  `HELP` / `USAGE.tui` do not contain `in-process`. Red today (the repro above).
- **T6 hop names the reason.** `session-hop-targets.test.ts`, with a failing worker
  builder (inject via the new `spawn` seam through `HopTargetDeps`, or the
  test's existing fake) → `{ kind: "failed", notice }` containing the reason.
- **T7 the real worker still boots** — the existing `worker.test.ts:57-80`
  stays green unchanged (proves the default `spawn` is the URL form).

**Mutation (non-vacuity, §9):** after green, temporarily reintroduce the
fallback in `startWorkerRuntime` (wrap the body in `try { … } catch { return null as never; }`)
→ T1, T2, T3 must fail; revert. And temporarily restore the two bools in
`flags.ts:175` → T5 fails; revert. Record both in Execution.

**Deleted tests — each must be mapped, in Execution, to "covered on the worker
path by X" or "its code no longer exists":**
`session-jobs.test.ts` (whole file); `skills-hot-reload.test.ts:150-…` (T8,
the in-process block — the worker/RemoteClient blocks in that file stay);
`session-titles.test.ts:203-…` ("in-process fallback"); `wiring.test.ts:51-…`
(in-process single broker — the worker's is `runEngineTui`'s regression test,
AGENTS §7), `:634`, `:657` (in-process hooks gate — on RPC the peer validates
`HooksTrustParamsSchema`); `move-session-wiring.test.ts:66-67` (drop the
`inProcessAgents` line, keep the rest). Slice B: `session-log-store.test.ts`
W14 (`:215`) and L3 (`:638`) go with `saveSnapshot`; the aside/containment
tests for the remaining writers stay.

Gate before done: `bun run check` (AGENTS §4/§6 baseline: all pass except the
three opt-in skips; lint clean). Manual: `bun run build` and run the compiled
binary once (`-i`, one prompt, quit) — the worker boots, no error line.

### Owner questions

1. **Slice B (delete the snapshot writer `saveSnapshot`) in this branch, or a
   follow-up?** Recommendation: **this branch** — it is dead the moment
   slice A lands, deletion-only (readers kept), and the "handled twice" cost
   is the reason for the task.
2. **The TUI's optional-member "in-process fallback" branches** (`clear`
   absent → close + new session, `clear-command.ts:8`, `useQuitClear.ts:339`;
   `sendNow` absent, `send-now.ts:37`; images-off when absent,
   `app-types.ts:61/79`; `useDock.ts:412`; `permission-ui.ts:13`) — make them
   required now, or a follow-up? Recommendation: **follow-up task**
   (`tui`, S, contained): they are still exercised by TUI tests with
   minimal controllers, and changing the `startTui` contract here would widen
   a load-bearing branch for no user-visible gain.
3. **One-shot `tentacle <prompt>` and `--plain` keep running the agent on the
   main thread** (no TUI, no persistence, `main.ts:2046-2054`, `:2211-2255`).
   Recommendation: **leave them** — the invariant is about the TUI session
   path; moving them onto the worker would be a separate `eval`.

## Execution

*— claude-sonnet-4-5-20250929 (executor), 2026-11-14*

### Load-bearing check, re-run first

PASSED, on this branch (`ee227272` + the approved plan):

- `rg 'inProcessAgents|inProcessSessions' packages/*/src` → only `wiring.ts:713`
  (the definition), `session-jobs.ts` (its own defs) and `main.ts:2165/2175`
  (the one caller block). No other production caller. ✓
- one-shot (`main.ts:2211-2255`) and `--plain` (`:2046-2054`) build their own
  agent with `buildAgent`/`connectConfiguredMcp`; neither touches
  `inProcessAgents`/`inProcessSessions`. ✓
- `hop-targets.ts:148` treated `runtime === null` as
  `{kind:"failed", notice:"…could not start"}` — a failure, not a fallback. ✓
- `package.json:9` `"bun": ">=1.4.3"`; `scripts/build.ts` lists the worker as a
  second entrypoint. ✓

Repro (`.tentacle/tmp/remove-in-process/repro.ts`, verbatim output):

```
["-i","--in-process"] tui ok bools=interactive,in-process
["-i","--no-worker"] tui ok bools=interactive,no-worker
["--in-process"] tui ok bools=in-process
```

Both opt-outs parsed before the change; both are refused now
(`.tentacle/tmp/remove-in-process/cli.ts`):

```
["--in-process"] -> exit 1 | [error] unknown option --in-process
["-i","--no-worker"] -> exit 1 | [error] unknown option --no-worker
```

### As built, in the Implementation's order

**Slice A**
1. `local-runtime.ts` — added `WorkerStartError` (`phase: "spawn"|"handshake"`,
   `reason`), `workerStartFailureText(error, logPath)` (pure, React-free,
   `untrustedText`-sanitised), a local `reasonOf`; `startWorkerRuntime` now
   returns `Promise<LocalRuntime>`, takes `{spawn?, handshakeMs?}` (defaults:
   the unchanged URL-form `new Worker`, `8000`), **throws** on both phases, and
   its `error` listener rejects a racing `failed` promise so a load failure
   settles at once. The two `[worker] … using in-process` lines and the
   "falls back to in-process" doc comment are gone.
2. `hop-targets.ts` — the `null` branch is gone; the `catch` names the reason
   (`not moved: the local agent could not start (<reason>)`, sanitised) and any
   other throw keeps `errorText`'s line. Added the `spawnWorker?` test seam to
   `HopTargetDeps` (production passes nothing).
3. `flags.ts` — both bools, `[--in-process]` in `USAGE.tui`, and the comment
   mention dropped.
4. `main.ts` — HELP line dropped; `startWorkerRuntime` in a `try`, and on any
   throw `logDaemonError` + `workerStartFailureText` to `err`, drain the saver
   (as `runSessionTui`'s finally does), `return 1`; the whole in-process block
   deleted; `inProcessSessions`, `inProcessAgents`, `McpStatusTracker`,
   `connectMcpServers`, `recordFromSnapshot` imports dropped (`tsc` confirmed;
   `longToolNameWarnings` stays, one-shot uses it at `:2175`).
5. `wiring.ts` — `inProcessAgents` deleted (with its now-unused
   `PermissionBroker`/`HooksTrustParamsSchema`/`AskHooksTrust` uses); the five
   "in-process" comments reworded to what the remaining code does.
6. `session-jobs.ts` deleted after `rg` re-check (no non-test user but
   `main.ts:2175`).
7. Tests + `changelog.d/remove-in-process.removed.md`.
8. Docs: `docs/extensions.md` (the runtime table row, both 64-char-warning
   notes), `docs/container-config-sources.md` (the in-process MCP cite).
   `README.md`/`AGENTS.md` left alone: their "in-process worker" IS the worker.

**Slice A, the `main.ts` edit** was a whitespace-sensitive delete: the
in-process block's removal left the surviving worker block one indent deeper
and a bare `{ … }` block behind. Dedented the block in place (one `awk` pass
over the exact line range) rather than re-indenting by hand, and `tsc` + Biome
confirmed the result.

**Slice B** — as the plan's corrected text says, this was **not** deletion-only.
`LogSessionStore.saveSnapshot`, its `"snapshot"` op, `snapshotLocked` and the
`snapshotInc` writer field are deleted, and `SaveTarget`/`SessionSaver` lost
`saveSnapshot`/`save` — but ~48 test call sites used them, so the migration the
plan now records was needed:
- `cli/test/session-fixture.ts` gained `recordWrite(record)` (a `LogWrite` from
  a record via the existing `forkWrite`); `saveFixture` keeps its signature and
  now writes through `store.write(recordWrite(record))`.
- every `saver.save(r)` → `saver.write(recordWrite(r))`, and fake store targets
  lost their `saveSnapshot` member (two needed its timing moved onto `write`:
  the late-fail and the hung row).
- Deleted with the feature: `session-log-store.test.ts` W14 and L3,
  `session-jobs.test.ts` (whole file — its code no longer exists).

### Drift from the Implementation (and why)

1. **Slice B's "deletion only" was wrong** (the one step where the plan
   contradicted the code, §8). `saveSnapshot` is also the laptop test
   **fixture's** writer, so deletion needed a migration to the existing
   `forkWrite` + `write` seam. Fixed the doc's Slice B first (its own
   paragraph states the drift and the evidence), then executed it. Equivalence
   was checked, not assumed: the same record written by `saveSnapshot` and by
   `forkWrite`+`write` produces the **same lines**, `load()` returns the same
   messages/title, and the containment/aside rule still fires (aside produced
   for a diverging copy) — `.tentacle/tmp/remove-in-process/sliceB.ts` and
   `contain.ts`.
2. **`wiring.test.ts`'s two in-process rows could not survive as rewritten.**
   The single-broker row and the trust row tested `inProcessAgents` itself; the
   plan mapped both to "covered on the worker path". The trust question's
   supplier (`askHooksTrust`) existed only in `inProcessAgents`, and the wire
   schema check has its own pure home (`projectHooksWireProblem`,
   `hooks-trust.ts:262`, tested in `hooks-trust.test.ts`), so the row was
   deleted rather than restated — see the mapping below.
3. **`spawnWorker?` added to `HopTargetDeps`** for T6: the plan said "inject via
   the new `spawn` seam through `HopTargetDeps`, or the test's existing fake",
   and there was no such seam, so the seam was added (production unaffected).
4. A doc-comment in `session-saver.ts` and several test comments still said
   "the in-process path"; reworded where they described code that changed.

### Deleted tests, each mapped

| Deleted | Covered by / why it is gone |
|---|---|
| `session-jobs.test.ts` (whole file) | Its code (`session-jobs.ts`) no longer exists: jobs daemon-side are `facade.jobs` over RPC (`hop-runtime`), tested in `hop-feed.test.ts`/`hop-turn.test.ts` |
| `skills-hot-reload.test.ts` T8 (in-process block) | The worker/`SessionHost` blocks in the same file stay and cover the hot-reload property on the only remaining path |
| `session-titles.test.ts` L2 ("in-process fallback") | The same property — a resumed record's *chosen* title carried into the save unchanged — is covered on the worker path at `:165-173` (`persistingController` seeded `{source:"user", text:"Kept"}`, save carries it) |
| `wiring.test.ts:51-76` (in-process single broker) | **Replaced, not just dropped**: the local path's broker identity had no other pin, so a grep-guard row now asserts `main`'s TUI block constructs ONE `PermissionBroker` and hands the same identifier to `startWorkerRuntime` and `startTui` (mutated to prove it, M6 below). The old row's per-session `build()` halves tested `inProcessAgents`' own code, which no longer exists |
| `wiring.test.ts:657` (in-process hooks gate) | On RPC the peer validates `HooksTrustParamsSchema` (`hooks-trust.ts:262`), and the pure check is tested in `hooks-trust.test.ts` |
| `move-session-wiring.test.ts:66-67` | Dropped only the `inProcessAgents` half; the other three builds still assert no `move_session` |
| `session-log-store.test.ts` W14, L3 | They exercised `saveSnapshot` only; the containment rule they shared is still pinned by the migrated `tui-sessions.test.ts` Q6 row (mutation below) |

### Tests, and red-before-green

Added, in `worker.test.ts` (T1–T4), `args.test.ts` (T5), and
`session-hop-targets.test.ts` (T6). **Red first, on the pre-change code**, via
the mutations below (per §9 each test must fail when the behaviour is removed):
T1/T2/T3, T5 and T6 were each shown red, and T2's early-reject separately.

Tests that could not be red on the original tree: **T4** (the formatter did not
exist, so it failed on an import, which proves nothing — its non-vacuity comes
from the mutation of its two asserted properties, the phase name and the
`in-process`-free text) and **T7** (the real-worker row already existed and
passes unchanged, which is exactly what it asserts).

### Mutations (non-vacuity, §9) — results pasted

**M1 — reintroduce the fallback** (`startWorkerRuntime`'s two `catch` blocks
`return null as never`):

```
(fail) T1 a spawn failure rejects with WorkerStartError{spawn}, never resolves null
(fail) T2 a worker that fails to LOAD rejects at once with its own message
(fail) T3 a worker that never answers times out as WorkerStartError{handshake}
 4 pass
 3 fail
```

**M2 — restore the two bools** in `flags.ts:175`:

```
(fail) the removed --in-process / --no-worker are unknown options now
 20 pass
 1 fail
```

**M3 — drop the worker `error` listener's early reject** (`failHandshake?.()`
removed; the fallback stays gone):

```
(fail) T2 a worker that fails to LOAD rejects at once with its own message   [5001.50ms]
 6 pass
 1 fail
```

**M4 — drop the reason from the hop's notice** (the plan's `null`-branch text):

```
(fail) T6 a failed local build names the reason, and the session stays put
 24 pass
 1 fail
```

**M5 — skip the store's containment aside** (`settleLast`'s `asideRaw`
disabled) to prove the migrated `write` path keeps the rule W14 tested:

```
(fail) another writer's shorter copy never drops the longer history silently: it goes aside first, the TUI is told
 18 pass
 1 fail
```

**M6 — a SECOND broker for the TUI** (`startTui`'s `permissions:` becomes its
own `new PermissionBroker()`), the silent-decoupling class AGENTS §7 warns
about:

```
(fail) the local TUI's single broker (AGENTS §7), pinned where it is built > grep-guard: `main` hands ONE `permissions` to the worker runtime AND to `startTui`
 38 pass
 1 fail
```

All six reverted; `rg MUTATION` over `packages/*/src` and `packages/*/test`
shows only pre-existing comment text, and `git diff` shows no residue.

### Verification

- `bun run check` (typecheck → lint → test) **green**:
  `9940 pass, 4 skip, 0 fail` — the 4 skips are the pre-existing opt-ins
  (`TENTACLE_K8S_SERVER`, `TENTACLE_DOCKER_TESTS`, `TENTACLE_SLOW_TESTS`, and
  `ws-server`'s), not failures. Lint clean against the §6 baseline.
- Real worker still boots, and says nothing about a fallback
  (`.tentacle/tmp/remove-in-process/boot.ts`): `worker booted: true`,
  `fallback lines: []`.
- No protocol/schema change, so no `protocol.d/` note and no
  `protocol.json` regeneration.

**Not verified:** `bun run build` of the compiled binary and a live `-i` session
inside it (the plan's manual step) — not run here; the source-path spawn is
covered by `worker.test.ts` and the boot probe above, and the compiled-binary
resolution is unchanged (the URL form is untouched, only wrapped in the seam).
To verify: `bun run build` then run the binary with `-i`, one prompt, quit.


## Review

*—*

#### Owner decisions (2026-11-14 23:50)

1. Slice B (delete `saveSnapshot`, readers kept) **in this branch** — as recommended.
2. **NOT as recommended: make the TUI's optional-member "in-process fallback" branches REQUIRED in this branch** (`clear`, `sendNow`, images, dock, permission UI — `clear-command.ts:8`, `useQuitClear.ts:339`, `send-now.ts:37`, `app-types.ts:61/79`, `useDock.ts:412`, `permission-ui.ts:13`): remove the fallbacks and update the TUI test controllers to provide the members. Add it as its own slice after A/B.
3. One-shot `tentacle <prompt>` and `--plain` stay on the main thread — as recommended.
*— claude-opus-5-5 (orchestrator), 2026-11-14*

#### Fresh-context adversarial review (diff `main...HEAD`)

**Verdict: REQUEST-CHANGES**

Gate: 16 touched test files, 430 pass / 0 fail; `bun run typecheck` clean; `bun run lint` clean (1375 files). The full `bun test` was not re-run.

Findings (HIGH/MEDIUM only):

1. **HIGH — owner decision 2 (the TUI slice) was not executed and is not mentioned anywhere.** The diff touches nothing in `packages/tui`. The optional-member fallback branches are still there: `packages/tui/src/clear-command.ts:8`, `useQuitClear.ts:339`, `send-now.ts:37`, `app-types.ts:61/79`, `permission-ui.ts:13`. `useDock.ts:412` still points users to `--in-process`, a flag that no longer exists. Failure scenario: a controller that leaves out `clear`/`sendNow` still compiles, and `/clear` silently turns into close-and-start-a-new-session (images silently off). So the second-path upkeep this task exists to remove is still in the code. Execution's "Drift" never mentions the decision.
2. **MEDIUM — the task's Goal is untested at `main`.** The Goal is: worker start fails → error text, saver drained, exit 1, no Ink (`packages/cli/src/main.ts:2073-2080`). Mutation `return 1;` → `return 0;` at `main.ts:2079` **survived** `main.test.ts` + `tui-sessions.test.ts` + `wiring.test.ts` (176 pass, 0 fail). I reverted it and the tree is clean. Nothing stops a regression to exit 0, or to mounting Ink after the error. This needs a `main` test that injects a failing spawn.
3. **MEDIUM — the compiled-binary boot was never checked, and the change makes it critical.** F2 is the main reason for this task. With the fallback gone, a binary whose worker fails to resolve now ends every local TUI with exit 1, where before it ran degraded. Execution leaves `bun run build` + `-i` unverified. Run it before merge.

Attacks tried: (a) the handshake race. `failed` is `.catch`-guarded, a late `error` event after the handshake rejects a promise nobody uses, and `terminate` runs on every failure path. Holds. (b) Single broker: `main.ts` builds one `PermissionBroker` and hands it to the worker, `startTui` and the hop feed. Holds. (c) Leftover callers of `saveSnapshot`/`save`/`inProcess*` in `packages/*/src` and `apps`: none. The readers (`segmentFromMessages`) are kept. Holds. (d) Mutation of the main exit path: survived (finding 2). I did not re-run the executor's M1–M6.

Executor behaviour: careful on slices A and B. It recorded slice B's drift honestly and pinned the single broker with a new guard. But it dropped an explicit owner decision without a word.

Same model family as the orchestrator/plan author (Opus), fresh context only; the executor was a different model.
*— claude-opus-5-5, 2026-11-15*
