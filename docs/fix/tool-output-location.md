# fix/tool-output-location — Large tool output leaves the project

> **Status:** executed (round 2 done after the fresh-context Review); awaiting merge
> **Branch:** `fix/tool-output-location` (off `main` AFTER `feat/tui-target-badge` and `fix/stale-pod-binary` merge)
> **Type:** fix · **Size:** M · **Blast:** cross-module · **Suited:** a strong model for the `agent.ts`/`session-host.ts` edits (or Sonnet executes, Opus fresh-context Review — the change sits next to the agent loop and `SessionHost.delete`)

Planned on top of the two pending branches. Files shared with them (all
different regions, so only adjacent-hunk conflicts are possible):
`CHANGELOG.md` (both add under `[Unreleased]`), `packages/agent/src/agent.ts`
(badge adds `contextUsage` ~L1094 and imports; we touch L330 and L1721-1756),
`packages/daemon/src/session-host.ts` (badge adds `toolsReady` in the options
interface ~L127 and `newSessionContext` ~L236; we add one more option beside
it and edit `delete`), `packages/cli/src/worker.ts` and `serve.ts` (badge edits
inside the same `SessionHost({…})` literal in `worker.ts` ~L101 and
`tunnelledAgent` ~L389; we add one property to each literal). No overlap with
`fix/stale-pod-binary` besides `CHANGELOG.md`. Line numbers below are on
`main`; re-anchor after the merges.

## Context

*— claude-sonnet-5-5, 2026-11-05*

**Problem.** A tool result longer than `tools.maxInlineOutputChars` is written
to `<cwd>/.tentacle/tool-output/<tool>-<id>.txt` (`packages/agent/src/agent.ts:1739`,
written at `:1747-1754`). That puts model-run output — possibly holding secrets
the redactor missed — inside the user's project: a repo (the `.gitignore:25`
entry only covers tentacle's own repo), a Docker/Podman mount (so the pod writes
into the laptop folder; `docs/container-config-sources.md:194-197`, `:257-260`),
never cleaned up, shared by every session (names are `<tool>-<callId>`; two
sessions with the same call id overwrite each other).

**Owner decisions (2026-11-05, FINAL — `TODO.md:428`).** The daemon picks ONE
dir at start: `$XDG_CACHE_HOME` or `~/.cache` →
`…/tentacle/tool-output/<project-key>/<session>/<tool>-<id>.txt` if writable,
else `os.tmpdir()/tentacle-<uid>/tool-output/…`. Files `0600`. Deleted with the
session; files older than `tools.outputRetentionDays` (default 30) removed
silently at daemon start; a missing file reads as "no longer available". Old
`.tentacle/tool-output/` files are NOT touched (CHANGELOG line). Comparison:
Claude Code `~/.claude/projects/<p>/<s>/tool-results/`, opencode
`~/.local/share/opencode/tool-output/` (7 days), pi `os.tmpdir()`.

**Repro (feature gap, to re-run on `main` before any edit):** a fake `Agent`
whose tool returns 5 000 lines, `spillLargeOutput({maxInlineChars: 500})`, a
`HostExecution({cwd: tmp, root: tmp})`: after the turn, `tmp/.tentacle/tool-output/noisy-c1.txt`
exists. Pinned today by `packages/agent/test/agent-spill.test.ts:67-75`.

## Implementation

*— claude-sonnet-5-5, 2026-11-05*

### Load-bearing assumption

**The spill cannot be written through `env.writeFile`, but can still be read
by the model through `fs_read`.** Writes are confined to the workspace root —
`HostExecution.writeFile` → `confineWrite` throws `WorkspaceWriteError` for any
path resolving outside `root` (`packages/exec/src/host-execution.ts:215-227`,
class at `:40`) — while reads are explicitly unconfined (`:211-213`) and
`fs_read` has `permission: "none"` and goes straight to `ctx.env.readFile`
(`packages/tools/src/builtins.ts:79-84`, `:94`). Today's `writeSpill` uses
`this.config.env.writeFile(path, …)` (`agent.ts:1749`) and swallows the throw
into `null` (`:1751`) — so merely changing `path` to an absolute cache path
would make EVERY spill silently fail into the "could not be saved" truncation
(`result-pipeline.ts:93-96`). The confinement must NOT be loosened (it is the
workspace guarantee the model's `fs_write`/`fs_edit` rely on): the spill gets
its own writer, outside `env`. Reading it back needs no change.

### Preconditions

- The pod/container daemon is the same code: `buildAgent` makes a
  `HostExecution` in whichever process runs it (`packages/cli/src/wiring.ts:280`),
  used by `serve`, the in-process worker (`worker.ts:112`), `podSessionHost`
  (`serve.ts:452`) and the tunnelled pod agent (`serve.ts:393`). So the spill
  directory is "the daemon's host's cache" everywhere, and a pod's lives in the
  pod — consistent with §7 "compute next to the code" (the pod's output stays in
  the pod; nothing is written on the laptop for a pod session, nothing new
  crosses the wire). No protocol field changes.
- `ToolResultSpill.path` is an opaque string, max 4096 (`protocol/src/spill.ts:14`,
  mirrored `agent/src/session-store.ts:236`); the TUI only prints it
  (`tui/src/spill-view.ts:38-44`). An absolute cache path fits, no schema or
  `PROTOCOL_VERSION` change, and records already on disk with the old relative
  path stay valid (they just point at a file that is still there).
- `agent.ts:1727-1756` gets `sessionId` for every call (`extra.sessionId`), and
  `projectKey(cwd)` exists (`agent/src/session-store.ts:164`) with a safe-id
  rule `SAFE_ID` (`:153`).
- Config resolution pattern: env → file → default via `pick`
  (`config/src/resolve.ts:352-356`), schema `config/src/schema.ts:303`, load
  `config/src/load.ts:546`, template `config/src/defaults.ts:185-197`; config
  dir logic to mirror for the cache dir: `config/src/load.ts:370-383`.
- `SessionHost.delete(id)` is the one place a session is removed for good
  (`daemon/src/session-host.ts:423-440`, live and archived branches);
  archive/close keep the record (`:411`), so keep the files too (a reopen needs
  them). Remote deletion arrives there via `RemoteClient.deleteSession`
  (`client/src/remote-client.ts:667`, `connect.ts:179`).
- The TUI has **no** local-session delete: `SessionDirectory.remove` is only
  built for `connect` (`tui/src/App.tsx:267`, `connect.ts:179`); laptop
  in-process sessions are never deleted in-app. So for those the 30-day sweep is
  the only cleanup (stated in the CHANGELOG/docs; see Owner questions).
- Test isolation: `scripts/test-env-guard.ts` points `HOME` at a temp dir and
  strips `TENTACLE_*` (AGENTS §6), so a test that resolves the real cache dir
  stays in a sandbox; tests pass an explicit root anyway.

### Design

**New pure-ish module `packages/agent/src/tool-output.ts`** (agent already owns
`projectKey` and the session store; no new dependency), exported from
`packages/agent/src/index.ts`:

```ts
interface ToolOutputSink {            // what Agent needs
  write(sessionId: string, tool: string, callId: string, contents: string): Promise<string | null>;
}
interface ToolOutputStore extends ToolOutputSink {
  readonly root: string;
  forProject(cwd: string): ToolOutputSink;         // binds <project-key>
  removeSession(sessionId: string): Promise<void>; // rm -rf <root>/*/<sid>
  sweep(retentionDays: number, now?: number): Promise<void>;
}
function resolveToolOutputRoot(opts?: {env?, home?, uid?, tmp?}): string; // sync, probes
function createToolOutputStore(root: string): ToolOutputStore;
```

- **Root, chosen once per process** (`resolveToolOutputRoot`, called once and
  cached by a lazy `toolOutputStore()` in `cli/src/wiring.ts`, so every session
  and every sub-agent of this daemon shares the one answer): first candidate
  `join(XDG_CACHE_HOME || join(HOME || homedir(), ".cache"), "tentacle", "tool-output")`.
  Probe = `mkdir -p` (mode `0700`) + create/unlink a probe file; any failure →
  second candidate `join(os.tmpdir(), "tentacle-" + (process.getuid?.() ?? 0), "tool-output")`
  with the same probe. The second candidate's parent `tentacle-<uid>` is accepted
  only if `lstat` says: a real directory (not a symlink), owned by this uid, and
  mode forced to `0700` (the shared `/tmp` squat/symlink attack). Neither usable
  → `null` root: `write` returns `null` → existing "could not be saved"
  truncation path (`result-pipeline.ts:93-96`) — no new failure UX.
  A `config.cacheDir`-style helper `cacheDirFromEnv(env)` is added beside
  `configDirFromEnv` (`config/src/load.ts:370`) so the XDG rule lives in
  `@tentacle/config`, not duplicated.
- **Layout** `<root>/<projectKey(cwd)>/<safeSession>/<safeTool>-<safeId>.txt`.
  Every path segment passes one `segment()` sanitizer: `[^A-Za-z0-9_.-]`→`_`,
  max 60, and a segment that is empty or only dots becomes `_` (the existing
  `safe()` at `agent.ts:1738` lets `..` through; session ids are client-supplied
  over RPC, so this is a path-traversal guard, not cosmetics). Directories
  `0700`, files `0600` (create with `mode`, then `chmod` — an overwritten file
  keeps its old mode otherwise).
- **Agent seam.** `AgentConfig` (`agent.ts:330` area) gains
  `toolOutput?: ToolOutputSink`. `transformResult` (`agent.ts:1727-1756`): when
  set, `writeSpill` = `config.toolOutput.write(extra.sessionId, call.name, call.id, contents)`
  in the same try/catch → `null`; when absent, today's `env.writeFile`
  behaviour is kept (library use and the ~12 existing tests that fake `env`).
  This is a deliberate dual path in `Agent` only; production (`buildAgent`)
  always sets the sink. Update the doc comment at `agent.ts:1721-1726`.
- **Wiring** (`wiring.ts:279-425`): `buildAgent` passes
  `toolOutput: toolOutputStore().forProject(config.cwd)` to the main `Agent`
  (`:390`) and to `createSubagentRunner` deps (`:361`); `BuildAgentOptions`
  gets an optional `toolOutput` override for tests. The cwd is the session's
  cwd (`buildAgent({...config, cwd})`, `serve.ts:169`, `worker.ts:112`).
- **Sub-agents.** The child `Agent` runs under `crypto.randomUUID()`
  (`subagent.ts:232-233`) — its spill would land in a session dir nothing ever
  deletes. Fix: `agent_task` already knows the parent session (`ToolContext.sessionId`,
  `core/src/tool.ts:90`; it forwards `toolCallId`/`signal`/`onEvent` into
  `SubagentRunControls`, `tools/src/task.ts:57-62`) — add `sessionId` to
  `SubagentRunControls` (`subagent.ts:~89`) and give the child a sink that
  writes under the PARENT's session with the call id prefixed by the
  `agent_task` call id (`<taskCallId>.<childCallId>`, so a child's `call_1`
  cannot overwrite the parent's `call_1`). Absent `sessionId` (a direct runner
  call) → the random id, as today.
- **Deletion with the session.** `SessionHostOptions` (`session-host.ts`, the
  options interface where the badge branch adds `toolsReady`) gets
  `onSessionDeleted?: (id: string) => void`, called from `delete()` in both
  branches (live `:424-431`, archived `:433-436`) after the tombstone is added;
  never throws into `delete` (wrapped, errors → `onTurnError`-style log is not
  needed: `removeSession` swallows). The three construction sites pass
  `(id) => void toolOutputStore().removeSession(id)`: `serve.ts:162`
  (`startDaemon`), `serve.ts:430` (`podSessionHost`), `worker.ts:98`.
  `removeSession` validates the id with the same rule as `SAFE_ID`
  (`session-store.ts:153`) and `rm -rf`s `<root>/<each project dir>/<id>` — it
  scans the (few) project dirs rather than needing the cwd, so an archived
  session whose cwd is gone is still cleaned.
- **Sweep at daemon start.** `sweep(days)` (no-op for `days <= 0`): walk
  `<root>/*/*/*`, `lstat` (never follow a symlink, never descend one), unlink
  regular files whose `mtime` is older than `days × 86 400 000` ms, then remove
  now-empty session and project dirs; every error ignored; silent (no output —
  Ink may own the terminal, AGENTS §7). Called, not awaited, at the three
  daemon starts: `startDaemon` (after the lock, `serve.ts:~112`),
  `startStdioDaemon`/`podSessionHost` (`serve.ts:466/422`), and the worker's
  start (`worker.ts:~98`). Not run by one-shot/plain REPL (short-lived; the
  next daemon start sweeps).
  A session older than the retention that is later resumed has lost its files
  → the next item.
- **"No longer available".** `HostExecutionConfig` (`host-execution.ts:30-38`)
  gains `readHint?: (absPath: string) => string | undefined`; `readFile`
  (`:210-213`) catches `ENOENT` and, when the hint returns text, throws
  `Error("<path>: <hint>")`. `buildAgent` sets it for paths under the store root:
  `tool output no longer available (it is removed with its session and after N
  days) — re-run the command if you still need it`. `fs_read` surfaces the
  message as an error result as today. The same-uid shell `cat`/`grep` is
  unchanged (the OS message).
- **Config.** `tools.outputRetentionDays` (non-negative int, default 30, `0` =
  keep forever, symmetric with `maxInlineOutputChars: 0` = off); env
  `TENTACLE_TOOL_OUTPUT_RETENTION_DAYS` (same `pick(env, file, default)` pattern
  as `TENTACLE_MAX_OUTPUT_CHARS`, `resolve.ts:352`). Wired
  schema → resolve (value + source map, `:83`, `:130`, `:428`, `:457`) → load
  (`:546`) → `TentacleConfig` → sweep call. Default constant beside
  `DEFAULT_MAX_INLINE_OUTPUT_CHARS` in `defaults.ts`.
- **Old files.** Not touched, not migrated, not swept (owner). The
  `.gitignore:25` comment keeps its meaning for them.

### Files (dependency order)

1. `packages/config/src/defaults.ts` — `DEFAULT_TOOL_OUTPUT_RETENTION_DAYS = 30`; template comment (`:185-197`): spill goes to the cache dir, add `outputRetentionDays` to the `"tools"` example line and its doc bullet.
2. `packages/config/src/schema.ts` (`:303`), `resolve.ts` (`:83,:130,:352,:428,:457`), `load.ts` (`:82,:546`, + `cacheDirFromEnv` near `:370`) — option + env + cache-dir helper.
3. `packages/exec/src/host-execution.ts` — `readHint` + ENOENT rethrow.
4. `packages/agent/src/tool-output.ts` (new), `agent/src/index.ts` export.
5. `packages/agent/src/agent.ts` — `toolOutput` config, `transformResult`, doc comment.
6. `packages/agent/src/subagent.ts`, `packages/tools/src/task.ts` — parent session + prefixed call id for a child's sink.
7. `packages/daemon/src/session-host.ts` — `onSessionDeleted`.
8. `packages/cli/src/wiring.ts` — lazy `toolOutputStore()`, `buildAgent` wiring, `readHint`; `serve.ts`, `worker.ts` — hook + sweep at start.
9. Docs: `CHANGELOG.md`; `docs/container-config-sources.md` (`:194-197` replace the "Cambio pianificato" sentence with the as-built location; `:257-260` item 7 closed: the pod's cache is not the mounted folder unless the pod's `$HOME` is inside it); `TODO.md:428` → done line; this doc's Execution/Review.
   Help text: there is no CLI `--help` line for this option (grep of `main.ts` usage: none); the only user-facing config text is the `defaults.ts` template comment (item 1) and the CHANGELOG.

Tests move/updated: `packages/agent/test/agent-spill.test.ts:67-75` keeps
passing on the fallback; new tests below.

### CHANGELOG `[Unreleased]` (user-visible)

Under `### Changed` (the badge branch has added `### Added`, stale-pod `### Fixed`; keep Keep-a-Changelog order):

- **Large tool output no longer lands in your project.** Output too big for the
  context used to be saved in `.tentacle/tool-output/` inside the project (and
  in the mounted folder, for a Docker/Podman run). It now goes to your cache
  folder — `$XDG_CACHE_HOME/tentacle/tool-output/` or
  `~/.cache/tentacle/tool-output/`, or the system temp folder where that is not
  writable (e.g. a container running as a random user id) — readable only by
  you. A session's files are deleted with the session, and files older than
  `tools.outputRetentionDays` (default 30; `0` keeps them) are removed silently
  when the daemon starts; reading a removed one says it is no longer available.
  Files already in `.tentacle/tool-output/` are left alone: delete them by hand.

Under `### Added`: `tools.outputRetentionDays` / `TENTACLE_TOOL_OUTPUT_RETENTION_DAYS` — how long large tool outputs are kept (days, default 30, 0 = forever).

### Failure modes

| Case | Convergence |
|---|---|
| Neither candidate dir writable | `write` → `null` → existing truncation banner `could not be saved` (`result-pipeline.ts:93-96`); logged nowhere new; turn unaffected. |
| `/tmp/tentacle-<uid>` pre-exists as symlink / other owner / loose mode | rejected by the `lstat` check → store unusable → as above (never write through someone else's link). |
| Session id `..`, `a/b`, empty (client-supplied) | `segment()`/`SAFE_ID` rule: never leaves `<root>`; `removeSession` refuses an unsafe id. |
| Disk full / write error mid-spill | `try/catch` → `null` → truncation path (same as today). |
| Two sessions, same `callId` | separate session dirs; no overwrite (a bug today). |
| Sub-agent spill | under the parent session, call id prefixed → deleted with it, no collision. |
| Race: `delete` while a late spill write lands | `hosted.close("deleted")` runs first (`session-host.ts:428`); a write already in flight can recreate the dir for one file → swept by retention. Accepted; stated in Review. |
| Daemon restart | root re-resolved; existing files readable; sweep runs; `HOME` change between runs just means an orphan dir → retention. |
| Session resumed after retention removed its files | banner still in history; `fs_read` returns the "no longer available" error; the model re-runs the command. TUI row unaffected (shows `head`/`tail`, `spill-view.ts`). |
| `outputRetentionDays` 0 / negative | `0` = never sweep; negative rejected by the schema (non-negative int). |
| Pod session | files in the pod's cache/tmp; die with the pod or retention; never written on the laptop; the laptop's history keeps only the path string (§7: pod output is pod-supplied, only displayed). |
| Archived session (close/TTL) | files kept (reopen needs them); removed on `session/delete`. |
| Local in-process session (no delete in the TUI) | only the sweep removes them. |
| Windows / no `getuid` | uid `0` in the temp name; acceptable (Bun targets here are macOS/Linux). |
| Sweep walking a huge cache | `lstat` per entry, async, not awaited by startup; errors ignored. |

### Tests

Red first (each shown failing on `main`, then green), double quotes, no `!`.

1. `packages/agent/test/tool-output.test.ts` (new, temp-dir roots, fake clock):
   - layout `<root>/<key>/<sid>/<tool>-<id>.txt`, contents exact, file mode `0600`, dir `0700`;
   - `segment()` hardening: session `..`, `../x`, `a/b`, `` → stays inside root (assert `resolve(path)` startsWith root);
   - `removeSession` removes `<root>/*/<sid>`, leaves other sessions, refuses an unsafe id, idempotent on a missing dir;
   - `sweep`: file at 31 d removed, 29 d kept, empty session/project dirs pruned, `0` days = no-op, a symlink inside is neither followed nor its target removed;
   - `resolveToolOutputRoot`: XDG set → used; unset → `~/.cache`; first unwritable (point it at a path under a regular file) → `tmp/tentacle-<uid>/…`; tmp parent is a symlink / wrong mode → `null`.
2. `packages/agent/test/agent-spill.test.ts` (extend): with `toolOutput` set, `env.writeFile` is NOT called (spy) and the banner/`spill.path` carry the sink's path; sink rejecting → "could not be saved" banner (truncation), turn completes. **Red:** on `main` the config key doesn't exist (type/behaviour fails). Mutation: make `transformResult` ignore the sink → test fails.
3. `packages/exec/test/host-execution.test.ts` (extend): `writeFile` outside root STILL throws (guards against "fixing" the spill by loosening confinement); `readHint` turns an ENOENT under the hinted prefix into the hint message, other ENOENT unchanged, other errors unchanged.
4. Sub-agent: `packages/agent/test/subagent.test.ts` (extend, existing fakes): a child spill goes to the parent session with prefixed call id; with no parent id → random (old behaviour). Mutation: drop the prefix → collision test fails.
5. `packages/daemon/test/session-host.test.ts` (extend): `delete(live)` and `delete(archived)` each call `onSessionDeleted(id)` once; `close`/archive do not; unknown id → not called; a throwing hook does not break `delete`.
6. `packages/cli/test/wiring.test.ts` (extend `:246` area, which asserts `saved to .tentacle/tool-output/fs_read-r1.txt`): through `buildAgent` with an injected temp root, a big `fs_read` result is saved under the root, NOT under `cwd/.tentacle`; assert `existsSync(cwd/.tentacle/tool-output)` is false (the exact property the owner asked for); and the model can `fs_read` the path back (the load-bearing assumption, end to end). Mutation: pass no sink → falls back to `.tentacle` → fails.
7. Config: `packages/config/test` resolve/load — default 30, file value, env override beats file, negative rejected, source map reports it; template parses.
8. `packages/cli/test` serve/worker: with a persisting daemon (`startDaemon` fake store), a `session/delete` removes the session's spill dir; startup sweep removes an aged file (inject store root + clock).
9. Existing tests that hard-code `.tentacle/tool-output/…` paths as DATA (`tui`, `protocol`, `client`, `daemon` mapping tests, `result-pipeline.test.ts`) need no change: they feed literal strings. Only the two asserting real writes (`agent-spill.test.ts`, `cli/test/wiring.test.ts:246`) change.

Gate before done: `bun test` (narrow files while iterating), `bun run typecheck`,
`bun run lint` (baseline clean), `bun run check`. Mandatory fresh-context Review
that red-teams: (a) §7 "Never write raw to the terminal" (sweep prints nothing),
(b) "Don't serialize the RPC peer" (the `delete` hook is sync/fire-and-forget),
(c) pod-not-trusted (nothing from the pod reaches the laptop's disk or
approval), (d) `/tmp` squat.

## Execution

*— claude-sonnet-5-5, 2026-11-06*

**As built, in plan order** (all `file:line` re-verified against main 8139e78 first):

1. Config: `tools.outputRetentionDays` (schema `z.number().int()` — negatives allowed per the owner answer), env `TENTACLE_TOOL_OUTPUT_RETENTION_DAYS` via a new `parseInteger`, source map, `TentacleConfig.toolOutputRetentionDays`, `cacheDirFromEnv`, template text. Test: `config/test/tool-output-retention.test.ts`.
2. `exec/host-execution.ts`: `readHint` + ENOENT rethrow; confinement untouched (test pins it). Test: `exec/test/read-hint.test.ts`.
3. `agent/src/tool-output.ts` (new): `segment`, `resolveToolOutputRoot` (sync, probes; `/tmp/tentacle-<uid>` accepted only as a real dir, ours, mode 0700), `createToolOutputStore` (`write`, `forProject`, `owns`, `removeSession`, `sweep`; `<= 0` = no sweep, lstat only, symlinks never followed). Test: `agent/test/tool-output.test.ts`.
4. `agent.ts`: `toolOutput` config + sink path in `transformResult`; env fallback kept for library use.
5. Sub-agents: `SubagentDeps.toolOutput`, `SubagentRunControls.sessionId` (+ `TaskRunControls.sessionId`, `task.ts` forwards `ctx.sessionId`). The child's sink writes under the PARENT's session.
6. `session-host.ts`: `onSessionDeleted`, called in both `delete` branches, throw-guarded.
7. `cli/wiring.ts`: lazy `toolOutputStore()`, `sweepToolOutput`, `toolOutputGoneHint`, `BuildAgentOptions.toolOutput`; `serve.ts` (`reloadedHost`, `podSessionHost`) and `worker.ts`: sweep at start + delete hook.
8. Docs: CHANGELOG (Changed/Added/Fixed), `container-config-sources.md`, TODO line.

**Drift from the plan (and why)**
- **Sub-agent call-id prefix:** task 7 already gave each child a random `spillScope`, so the plan's `<taskCallId>.<childCallId>` prefix is not needed; the scope is passed to the sink as `<scope>-<callId>`. Only the parent session id was added.
- **NIT 5:** giving the parent a random scope would NOT fix it (two same-id calls in one Agent share the scope). Fix = `Agent.spillId`: the first use of (session, scope, tool, id) keeps the plain name, a repeat gets `~2`, `~3`…; the check+claim is synchronous so parallel calls cannot both take a name. It also covers an id reused across turns. Applies to the sink path and the env fallback.
- `resolveToolOutputRoot` is synchronous (plan said "sync, probes"; kept so `toolOutputStore()` is a plain lazy singleton).
- Loose-mode `/tmp/tentacle-<uid>` is REJECTED (→ null root), not chmod'ed: the plan's text said both; the failure table says rejected, the safer one. *orchestrator decision (owner delegation 2026-11-06)*
- `outputRetentionDays` is not in the carried-settings table (a daemon-local sweep setting, nothing for the pod to receive).
- Red-first: the sink/NIT-5 tests were run red on the unmodified `agent.ts` (5/5 fail on assertions); `readHint` red on assertion; `onSessionDeleted` red on assertion. The store module's tests were written with the module (no pre-existing code to be red against); they were validated by mutation instead.

**Mutations (cp backup, shasum identical after each)** — all red then restored:
sink ignored (4 fail) · dedupe disabled (2 fail) · child ignores parent session (1) · `delete` live branch without hook (2) · `readHint` ignored (1) · sweep ignores mtime (1) · sweep ignores `<= 0` (1) · `removeSession` without id guard (1) · wiring without `toolOutput` (1) · `serve.ts` without sweep/hook (2) · `task.ts` without `sessionId` (1). **Not mutated:** the "symlink never followed" guard (lstat-based; only asserted by test, mutation not done).

**Gate (once, at the end):** `bunx tsc --noEmit` clean · `bunx biome check .` clean · `bun test packages`: 4916 pass, 3 skip (opt-in), 0 fail.

**Unverified:** a live run in a real pod/container (HOME unwritable → tmp fallback) and on Windows; verify by `tentacle run` with a random uid and a large `fs_read`.

### Execution — round 2

*— claude-sonnet-5-5, 2026-11-06*

Implements the orchestrator decisions F1–F6, Q1, Q2. Red first: `agent/test/tool-output-round2.test.ts` was run on the round-1 store: 12 fail on assertions (3 pass), then green after the change.

- **F1+F2** (`tool-output.ts` `writeIn`): exclusive create (`flag: "wx"`), on `EEXIST` retry `<tool>-<id>~N.txt` — the suffix is added AFTER `segment()`, so it survives the 60-char cut and `c~2` / `c_2` / `a`+`b-c` / `a-b`+`c` cannot share a file. The store is now the truth; the `chmod` is gone (a new file is created 0600). `Agent.spillId`/`spillNames` kept ONLY for the env fallback path (no sink; the library path still needs it, tested), and returns the plain id when a sink is set. Tests: two stores/two Agents of one session, 60+/80-char id repeated, 8 parallel writes. The obsolete "overwritten file is 0600 again" test became "a repeated name is never overwritten"; the sink test "two calls reach the sink under two names" became an Agent+real-store test (two files).
- **F3**: only absolute cache bases (XDG, then `$HOME/.cache`), else tmp, else `null` (`resolveToolOutputRoot`; tests for a relative `XDG_CACHE_HOME` and `HOME=""`).
- **F4**: `removeSession` does `isRealDir(<root>/<project>)` first (test: symlinked project dir not followed).
- **F5**: `sessionDirName(id)`: a safe id (`^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$`) keeps its name, anything else becomes `~<sha256[:16]>`; used by `write` and `removeSession`; `removeSession` no longer refuses unsafe ids (it hashes them, so it can only reach that id's own dir). Tests: `a_b` vs `a b`, 70-char id vs longer same-prefix id, hostile ids, plain name kept.
- **F6**: `cacheDirFromEnv` and its test removed; doc header status updated.
- **Q1**: `createToolOutputStore(root, alternative?)`; for a project whose cwd contains the root (realpath-compared), the write goes to the lazily resolved tmp root (`resolveToolOutputTmpRoot`, wired in `toolOutputStore()`), `null` when that is inside the cwd too or missing — never the project. `owns`, `removeSession` and `sweep` cover both roots. Tests: store-level (inside → tmp, outside → unchanged, no alternative → null).
- **Q2**: one paragraph in `container-config-sources.md` (the pod uses its own retention default; the tmp-root rule).

**Drift:** no wiring-level (`buildAgent`) test for Q1, only the store-level ones; `wiring.ts` changes by one line. The scratch repro (`.tentacle/tmp/tool-output-location/repro.ts`) could NOT be run: `bun <path>` was denied approval in this session, so its output is not pasted; the same properties are covered by the new tests. `alternative` is resolved on demand by `removeSession`/`sweep`/`owns` (creates `/tmp/tentacle-<uid>/tool-output` at the first sweep) so files from a previous run stay reachable. No CHANGELOG change (the visible behaviour is the round-1 entry; these are corrections within it).

**Mutations (cp backup, shasum identical):** `wx`→`w` (4 red) · XDG absolute check dropped (1) · project-dir `isRealDir` dropped (1) · `removeSession` uses the raw id (3) · Q1 `lies` check dropped (2).

**Gate:** `bunx tsc --noEmit` clean · `bunx biome check .` clean (673 files) · `bun test packages`: 4931 pass, 3 skip, 0 fail.

## Review

*— claude-opus-5-5, 2026-11-06*

**Verdict: REQUEST-CHANGES.** 1 MEDIUM, 5 LOW. The core move holds: production spills leave the project, read back in every runtime, and a failed spill never costs the turn. The blocker is that the dedupe does not hold across Agents of one session.

**Evidence limits.** The scratch repro (`.tentacle/tmp/tool-output-location/repro.ts`, gitignored) did NOT run: running it needed an approval that was not available. So findings 1-5 come from reading the code and are not executed; the brief's end-to-end trace and the Repro on `main` were not done. Run that script while fixing. Only the gate and the mutation below were executed. Reviewer and executor are different models of the same vendor family.

### Findings

1. **MEDIUM: a second Agent of the same session silently overwrites an earlier spill.** `Agent.spillNames` (`packages/agent/src/agent.ts:515`) is memory-only and per-Agent, while the store writes with a plain overwrite (`packages/agent/src/tool-output.ts:153`). The session id survives a `--resume`, a `serve` reload and a pod re-attach (`open{messages}`, AGENTS §7), and each builds a new Agent over the same `<session>` dir. A server that restarts ids at `call_1` then replaces the old file: the banner still in history points at different content, with no error. `main` overwrites too, so this is not a regression, but Execution's "covers an id reused across turns" is only true within one Agent, and this is the silent-wrong-state class. **Fix:** make the store the truth: exclusive create (`flag: "wx"`) with a retry on a new suffix on `EEXIST`, in `writeIn`. The `Set` can then go. Pin it with two Agents and one store.
2. **LOW: the dedupe suffix does not survive `segment()`.** `packages/agent/src/tool-output.ts:48,152`: an id of 60+ chars (51+ with a child's scope) loses `~2` to the cut, so the repeat overwrites. `~` becomes `_`, so `c~2` and a real `c_2` share a file. `a` + `b-c` and `a-b` + `c` also share one, while the `spillNames` key sees them as different. Same fix as 1.
3. **LOW: a relative cache base lands in the process cwd, so possibly in the project.** `packages/agent/src/tool-output.ts:104-106`: `XDG_CACHE_HOME=rel` or `HOME=""` gives a relative root. The write then follows the process cwd, `fs_read` resolves against the session cwd (a different file when they differ), and `owns` is false, so no hint. The XDG spec says to ignore a relative value. **Fix:** accept only absolute candidates, else the next one. Rare trigger, but it is the exact property this task exists for.
4. **LOW: `removeSession` follows a symlinked project dir.** `packages/agent/src/tool-output.ts:175-178` checks only `<project>/<id>` with `lstat`, which follows the `<project>` component. With `<root>/evil -> /some/dir`, deleting session `x` removes `/some/dir/x`. `sweep` checks this level (`:193`); `removeSession` does not, and no test covers it. Planting the link needs the same uid, so there is no privilege gain, but it breaks "a cleanup stays in its dir". **Fix:** `isRealDir(join(root, project))` first, plus a test.
5. **LOW: `write` and `removeSession` name a session differently.** `write` uses `segment(id)`; `removeSession` uses the raw id behind `SAFE_SESSION` (`packages/agent/src/tool-output.ts:150,171,176`). `SessionIdSchema` is only `min(1)` (`packages/protocol/src/session.ts:20`), and I found no id check in `session-host.ts`. So a >60-char id leaves its files until retention, while deleting `a_b` removes the spills of a live `a b`, and deleting a 60-char id removes those of a longer live id with that prefix. Needs a client-chosen id: the TUI's own uids are unaffected. Fix: a collision-free directory name for any id `segment` would alter (a hash), used on both sides.
6. **LOW: leftovers.** `cacheDirFromEnv` (`packages/config/src/load.ts:399`) has no production caller and its rule differs from `resolveToolOutputRoot` (it expands `~`), which contradicts the plan's "not duplicated": remove it. The first candidate has no `lstat`/owner check (`packages/agent/src/tool-output.ts:107`), which only matters for a shared `HOME` such as `/tmp`, i.e. a pod, already untrusted. The doc header still says "plan, awaiting approval".

### Attacks tried

| Attack | Result |
|---|---|
| Landing place per runtime | All production paths go through `buildAgent` (`wiring.ts:340`), the only `new Agent` besides the child (`subagent.ts:234`): worker, `serve`, pod and tunnelled. Each uses its own host's cache. Holds, except finding 3 and the Q1 case. |
| Read-back | `fs_read` is `permission: "none"` and unconfined; the banner carries the absolute path; `wiring.test` pins it through `buildAgent`. In a pod the model reads the pod's file. Holds. |
| Pod not trusted | `spill.path` is only printed (`tui/src/spill-view.ts:38-44`); nothing on the laptop opens it. No wire change. Holds. |
| §7 persistence | The worker and pod daemons write only a side file, no session record, and nothing crosses the wire. The in-process file is on the laptop, by owner decision. Holds. |
| Traversal in `write` / `removeSession` | `..`, `a/b` and empty are neutralised or refused (`segment`, `SAFE_SESSION`; JS `$` has no trailing-newline gap). Holds. |
| Symlink in `sweep` | Never descended or followed. Holds, proved by the mutation. |
| Live session's spills | Close and archive keep them. Age sweep can remove a live session's old file (hint given, accepted). Deleting another session reaches them only via finding 5. |
| Parallel children | Random `spillScope` per child (`subagent.ts:250`), filed under the parent's session. No collision within 51 chars of id. Holds. |
| Config | The `tools` key is typed and the schema is strict per its header; `.int()`; `<= 0` never sweeps; a non-integer env value falls through to file/default, as with the sibling parsers. Holds. |
| Loose `/tmp/tentacle-<uid>` rejected | Right. It is the same check as `control-socket.ts:146`, and that dir is shared with the sockets and the resident state. A loose dir could already hold planted entries, which a `chmod` would not clear. Cost: truncation, with no reason given. |
| Disk full / unwritable / null root | `writeIn` catches everything → `null` → the "could not be saved" banner with the preview (`result-pipeline.ts:93-96`); `Agent` has its own catch too. The turn survives. A partial file can remain until retention. Holds by reading; sink-reject is pinned by a test. |

### Premises

TRUE, opened: `writeFile` confined and reads unconfined (`host-execution.ts`), `fs_read` permission none, `SAFE_ID` and `projectKey` (`session-store.ts:153,164`), banner (`result-pipeline.ts`), `delete` branches (`session-host.ts`), spill path only printed. Not opened: the TUI's no-local-delete premise (grep of `App.tsx` was inconclusive) and the rest of the plan's citations. Symptom on `main`: not re-run (see limits); the old path is visible in the diff.

### Gate and mutation

- `bunx tsc --noEmit`: clean. `bunx biome check .`: clean, 672 files.
- `bun test packages/agent packages/config packages/daemon packages/exec packages/tools packages/cli`: 3226 pass, 1 skip, 0 fail. The reaper flake did not fire.
- **Mutation:** `isRealDir` (`tool-output.ts:124`) changed to accept symlinks, the guard the executor had not mutated: `a symlink is neither followed nor does its target go` went RED (1 fail, 15 pass). Restored; shasum identical (`37d790eb…`).

### Questions (recommendation for the orchestrator)

- **Q1. Root inside the session's cwd** (image with `HOME` = mounted workspace, or `tentacle` run from `~`): `container-config-sources.md` accepts it, but then a pod writes into the laptop's folder, the original complaint. **Recommend:** when the root lies inside `cwd`, use the tmp candidate for that project. There is precedent in the `binDir` mount refusal (`workspace-mount.ts:659`).
- **Q2. The laptop's `outputRetentionDays` does not reach a pod**, whose own default of 30 applies. **Recommend:** accept (pods rarely live that long) and add one line to `container-config-sources.md`.

### How the executor behaved

Honest and thorough on the gate, mutations and drift, and it named the symlink guard as unmutated; that guard holds. The one overclaim is the NIT 5 scope ("covers an id reused across turns"): it reasoned per Agent, while the directory is per session.

## Owner questions

*— claude-sonnet-5-5, 2026-11-05*

The entry answers nearly everything; two points it leaves open, neither blocking:

1. **`outputRetentionDays: 0` = keep forever?** The entry gives only the default (30). I planned `0` = never sweep (same convention as `maxInlineOutputChars: 0`). **Recommend:** yes.
2. **Laptop in-process sessions are never deleted in-app** (the TUI has delete only for `connect`), so for them the 30-day sweep is the only cleanup — "deleted with the session" holds for `serve`/`connect`/pod daemons only. **Recommend:** accept (no new delete UI in this task); a local-session delete, if wanted later, is a separate `feat`.

### Owner answers (2026-11-05)

1. `tools.outputRetentionDays`: `0` **or any negative value** (e.g. `-1`) = never sweep. The schema accepts negative integers (not "non-negative").
2. Local in-process sessions have no in-app delete: only the age sweep cleans their files. Accepted; no local-session delete in this task (a separate `feat` if ever wanted).

### Orchestrator decisions on the Review (owner delegation 2026-11-06)

- **F1 + F2 → fix:** the store is the truth: exclusive create (`flag: "wx"`) with a retry on a new suffix on `EEXIST`, in `writeIn`, applied after `segment()` so the suffix survives; drop the per-Agent `Set` if no longer needed. Test: two Agents over one store, and a 60+-char id repeated.
- **F3 → fix:** accept only absolute cache-base candidates (XDG spec), else the next one; test.
- **F4 → fix:** `removeSession` checks `isRealDir(join(root, project))` first; test with a symlinked project dir.
- **F5 → fix:** one collision-free directory name for a session id on both sides (`write` and `removeSession`): ids that `segment` would alter get a hashed name; tests for `a_b` vs `a b` and the long-prefix case.
- **F6 → fix:** remove `cacheDirFromEnv` (no caller); update the doc header status.
- **Q1 → yes:** when the resolved root lies inside the session's `cwd`, use the tmp candidate for that project (precedent: `workspace-mount.ts:659`); test.
- **Q2 → accept:** one line in `container-config-sources.md` (a pod uses its own retention default).
- Run the reviewer's scratch repro (`.tentacle/tmp/tool-output-location/repro.ts`) and paste its output in Execution.

*— claude-opus-5-5 (orchestrator), 2026-11-06*

## Review — round 2

*— claude-opus-5-5, 2026-11-06*

**Verdict: PASS.** 6 LOW, no MEDIUM or higher. Every decision (F1-F6, Q1, Q2) is implemented. One orchestrator step is still open: the scratch repro has not been run (finding 6). Scope: `git diff e297947..HEAD`.

**Evidence limits.** Only the gate and the mutation below were executed. `bun <script>` needed an approval that was not available here, so neither `repro.ts` nor my `attack2.ts` (same scratch dir, attacks A-M, including the real wiring with `HOME` = the project) ran. So the findings and every "holds" below come from reading the code, unless the row cites a test. The reviewer and the executor are different models of the same vendor family, so they may share blind spots.

### Decisions

| Decision | Implemented | Evidence |
|---|---|---|
| F1 exclusive create + retry | Yes: `flag: "wx"`, retry only on `EEXIST` (`tool-output.ts:242-253`) | `wx`→`w` mutation by the executor (4 red); tests with two stores, two Agents, 8 parallel writes |
| F1 bounded | Yes: `MAX_ATTEMPTS` 1000, then `null`, which gives the "could not be saved" banner | Reading only; no test reaches the limit (acceptable) |
| F1 concurrent writers | Yes: `O_EXCL` decides each name, across stores and processes. A dangling symlink at a name gives `EEXIST` and is not followed | 8-parallel test |
| F2 suffix survives `segment` | Yes: the suffix is added after `segment` (`:241-243`), and `segment` turns `~` into `_`, so a stem never contains `~` | My mutation below |
| F3 absolute bases only | Yes (`:139-142`); `HOME=""` falls to tmp | Executor's mutation on the XDG check; the `HOME` check was not mutated, but its test pins the exact root |
| F4 project-level symlink check | Yes (`:274`) | Executor's mutation (1 red) |
| F5 one session dir name | Yes: `write` and `removeSession` both use `sessionDirName` (`:239`, `:270`). `sweep` and `owns` do not use the name, and need not: they walk dirs or compare the root prefix. See finding 3 | Executor's mutation (3 red) |
| F5 old round-1 dirs | Moot: round 1 is not on `main` (`git merge-base` checked). A leftover dev dir would age out through `sweep` | Reading |
| F6 `cacheDirFromEnv` removed | Yes: no match in the repo outside this doc; header updated | Grep, `tsc` |
| Q1 root inside cwd | Yes (`:215-224`). The one-line `wiring.ts:255` is right: both resolvers use the same defaults, and `alt` is lazy and memoised | Store-level tests. The wiring line has no test (finding 2) |
| Q2 doc line | Yes, plus the tmp-root rule (`container-config-sources.md`, section 2.9 area) | Read |
| `Set` kept | Justified: `spillId` returns early with a sink (`agent.ts:1900`), and the library env path has no store. Production always passes a sink (`wiring.ts:470,510`), and the child wraps the parent's (`subagent.ts:251`) | Reading |
| Run the repro, paste its output | **No** | Finding 6 |

### Findings

1. **LOW: `cwd=/` loses every spill.** `tool-output.ts:219-223`: both roots lie inside `/`, so `rootFor` returns `null`. Each large output is then cut to the preview with a "could not be saved" banner. Reachable with `cd / && tentacle`, or `attach` to an image whose WORKDIR is `/`. It fails loud, and "never the project" is the decided rule, but `/` is not really a project and the model loses the output. **Option:** treat `cwd=/` as containing no root.
2. **LOW: three parts of Q1 have no test that pins them.** (a) `!lies(other, cwd)` (`:223`): no test has the alternative inside the cwd, and the `null` test passes `() => null`. So dropping that check would land spills in the project with every test green. (b) Sweeping the alternative root: the comment at `tool-output-round2.test.ts:172` says "swept", but the test never sweeps. (c) `wiring.ts:255`: removing the second argument fails no test, since a Q1 write would then just return `null`. **Fix:** three cheap tests. (c) can use `toolOutputStore().forProject(process.env.HOME)`, because the test guard already makes `HOME` a temp dir.
3. **LOW: "collision-free" does not hold on a case-insensitive filesystem.** `tool-output.ts:60-65`: `AB` and `ab` are both safe names, so on default APFS they are one directory, and deleting one removes the spills of the other. The doc comment "Two different ids never share a directory" is false there. It needs client-chosen ids that differ only in case.
4. **LOW: a swept name can be reused.** `tool-output.ts:243`: once `t-1.txt` ages out while its banner is still in history, the next write with a reused id takes that name again. That banner now reads different content with no error, and no "gone" hint. The header's "no spill ever replaces another" (`:9-11`) is not quite true over time. It needs a resumed session older than the retention period and a server that reuses ids.
5. **LOW: a cwd below the root's parent still writes into the mount.** `HOME=/w`, `cwd=/w/sub`: the root does not lie inside the cwd, so the spill lands in `/w/.cache`, in the laptop's folder if `/w` is mounted. Q1 was decided as "inside the session's cwd", and the code matches that. The original complaint survives only in this rarer shape.
6. **LOW: process and tidiness.** The orchestrator's repro step is unmet by both the executor and this review, and needs one approved run: `bun .tentacle/tmp/tool-output-location/repro.ts`, then `attack2.ts`, with `HOME` and `TMPDIR` set to scratch dirs. `repro.ts` was written against round 1, so its section 2 pokes at internals and may need adjusting. The two new tests in `agent-spill-sink.test.ts` remove `root` but leave `project` in tmp. `roots()` (`:202-213`) also creates the tmp root at every daemon start, and tests that use the real `toolOutputStore()` (`serve-persistence.test.ts:419,439`) now reach the real `$TMPDIR/tentacle-<uid>/tool-output`, outside the test env guard.

### Attacks tried

| Attack | Result |
|---|---|
| Retry loop with a non-`EEXIST` error | Stops at once: the outer catch returns `null`. Holds |
| Partial write on a full disk | The name stays taken, the banner is honest, and retention removes the file. Holds |
| Child scope plus a long id | `segment` cuts the stem, and the suffix still applies after the cut. Holds |
| Hashed name equal to a plain one | Not possible: `~` is outside `SAFE_SESSION`. Holds, except finding 3 on case |
| Hostile ids in `removeSession` | Hashed, so they reach only that id's own dir (test at `round2.test.ts:139`). Holds |
| Sibling prefix (`/x/proj` vs `/x/proj-cache`) | `lies` compares with a trailing `/`. Holds |
| Symlinked cwd or root | Both sides go through `realpath`. Holds |
| Root equal to the alternative (the root already fell to tmp) | Listed once by `roots()`, and `rootFor` returns `null` if it lies in the cwd. Holds |
| Root `null` with an alternative | `null`: the tmp root was already tried during resolution. Holds |
| `sweep` racing `writeIn` | `ENOENT` gives `null` and the banner. Loud, and rare |
| Pod not trusted, persistence, protocol (§7) | No wire or record change in this diff, and the spill path stays only printed. Holds |

### Gate and mutation

- `bunx tsc --noEmit`: clean. `bunx biome check .`: clean, 673 files.
- `bun test packages/agent packages/config packages/cli`: 2617 pass, 0 fail, 157 files. The reaper flake did not fire.
- **Mutation:** the suffix passed through `segment` (`tool-output.ts:243`): `a 60+ character id repeated still gets distinct files` went RED (1 fail, 14 pass). This site was not among the executor's mutations. Restored; shasum identical (`14667f20…`).

### How the executor behaved

Honest: it reported both the unrun repro and the missing wiring test as drift, and it showed five mutations. Two claims go too far: "the same properties are covered by the new tests" (finding 2), and the test comment that says "swept". It should have stopped and flagged the blocked repro as an open step rather than treating the tests as equivalent, though it did disclose it.

### Orchestrator live check + decision (owner delegation 2026-11-06)

Live, test binary main(afe15b5)+this branch(7974867), `run --engine docker --detach --no-mount` on ubi9, prompt `pwd; seq 1 200000`: `pwd` = `/`, result banner `[large shell output (1288903 chars), could not be saved to a file — only this preview is shown …]`. So round-2 Finding 1 is not rare: every `--no-mount` pod (WORKDIR `/`) loses every spill, while `main` saved it. A regression → **round 3, before merge**:
- **Finding 1 → fix:** a cwd of `/` contains no root (treat it as no project); test, plus a live re-check by the orchestrator.
- **Finding 2 → fix:** the three cheap tests (a) the alternative inside the cwd, (b) the alternative root is swept, (c) `wiring.ts:255` second argument pinned (`toolOutputStore().forProject(process.env.HOME)`).
- Findings 3–6: debt (TODO), no change.

*— claude-opus-5-5 (orchestrator), 2026-11-06*

### Execution — round 3

*— claude-sonnet-5-5, 2026-11-06*

- **Finding 1** (`tool-output.ts` `lies`): a cwd that resolves to `/` contains no root (a `--no-mount` pod, WORKDIR `/`, keeps its spills under the normal root). Red first: both `/` tests failed on the round-2 code (the spill returned `null`).
- **Bug found by the (a) test:** `real()` fell back to the *unresolved* path for a directory that does not exist yet, so on macOS (`/var` → `/private/var`) an alternative root not yet created was never seen as "inside the cwd" — the round-2 `!lies(other, cwd)` guard did not hold for it. `real()` now resolves the nearest existing ancestor and appends the rest.
- **Finding 2 tests:** (a) alternative also inside the cwd → `null`, nothing written; (b) the alternative root is swept; (c) `cli/test/tool-output-wiring.test.ts`: the real `toolOutputStore()` with cwd = `HOME` spills outside it, not `null`. Files: `agent/test/tool-output-round3.test.ts`, `cli/test/tool-output-wiring.test.ts`.
- **Mutations (cp backup, shasum identical):** `/` rule dropped (2 red) · `!lies(other, cwd)` dropped (1) · `roots()` without the alternative (1) · wiring without the 2nd argument (1). (The first wiring mutation attempt by `sed` did not match the reformatted line and showed 0 red; redone with an exact edit: 1 red.)
- **Gate:** `bunx tsc --noEmit` clean · `bunx biome check .` clean (675 files) · `bun test packages`: 4936 pass, 3 skip, 0 fail. Findings 3–6 untouched (debt). No CHANGELOG change.
