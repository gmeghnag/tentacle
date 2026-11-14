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
(`session-log-store.ts:340-348`), whose queue kind `"snapshot"` and
`snapshotInc` field (`:180`) exist for nothing else. Delete those (and the
`saveSnapshot` member of `SaveTarget`, `session-saver.ts:20`). **Keep**
`segmentFromMessages` (`session-log-file.ts:496`) — asides use it — and **every
reader**: a file already holding a laptop-minted segment must still load (no
format change, no `schemaVersion` change). Deletion only; the persistence
invariant's rules apply unchanged to the remaining writers.

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

*—*

## Review

*—*

#### Owner decisions (2026-11-14 23:50)

1. Slice B (delete `saveSnapshot`, readers kept) **in this branch** — as recommended.
2. **NOT as recommended: make the TUI's optional-member "in-process fallback" branches REQUIRED in this branch** (`clear`, `sendNow`, images, dock, permission UI — `clear-command.ts:8`, `useQuitClear.ts:339`, `send-now.ts:37`, `app-types.ts:61/79`, `useDock.ts:412`, `permission-ui.ts:13`): remove the fallbacks and update the TUI test controllers to provide the members. Add it as its own slice after A/B.
3. One-shot `tentacle <prompt>` and `--plain` stay on the main thread — as recommended.
*— claude-opus-5-5 (orchestrator), 2026-11-14*
