# TODO

Running backlog of planned work. The near-term roadmap is **skills support** next;
the rest are "value-add" improvements layered on the harness.

## v0.1.0 stabilization review (in progress)

Full code review, hot-path → polish, to stabilize a v0.1.0. Findings recorded
here as we go; fixes applied in a batch at the end. Severity: 🔴 blocker ·
🟡 should-fix · 🔵 nit/hardening.

### Block 1 — core execution (agent loop, provider/SSE, exec, result-pipeline)

- [x] 🔴 **Turn stalls silently after a tool call (needed a manual "go on").**
      FIXED (2026-10-14): a model that returns an *empty* round (no text, no tool
      calls) after a tool result would end the turn with nothing shown, forcing
      the user to type "vai avanti" to resume. `runMessages` now auto-nudges a
      stalled model to continue (internal user nudge `"Continue with the task."`,
      not surfaced as a `steer` event), bounded by `MAX_EMPTY_CONTINUES = 2` so a
      persistently-empty model still ends the turn instead of looping. Tests in
      `agent/test/agent.test.ts` (empty round → resumes; always-empty → bounded).
- [x] 🟡 **Auto-accept mode not discoverable in the TUI.** FIXED (2026-10-14):
      the status bar now *always* shows the mode — `⏵⏵ auto-accept off (shift+tab)`
      when off (advertising the keybind) and `⏵⏵ auto-accept on` when on — instead
      of appearing only when enabled. The indicator yields space (flexShrink)
      before the model name so a narrow line truncates the hint, not the model id.
      Tests in `tui/test/components.test.tsx` + updated `auto-approve.test.tsx`.
- [x] 🔴 **Mid-stream cancel surfaces as a *failed* turn, not a clean cancel.**
      FIXED (2026-10-14): `runMessages` now wraps the `model.stream` loop; on an
      `AbortError` with `signal.aborted` it yields `{turn_end, "cancelled"}` and
      returns (any other error still propagates). Tests added in
      `agent/test/agent.test.ts` (mid-stream abort → cancelled; non-abort error
      still throws). Also cleans up sub-agent cancellation (child abort now ends
      cleanly instead of becoming an `isError` task result). 353 tests green.
- [ ] 🔵 **Shell inherits the full `process.env`** (`host-execution.ts:80,132`),
      incl. `HARNESS_MODEL_API_KEY` etc. — a model-run `echo $HARNESS_MODEL_API_KEY`
      exfiltrates the key (redaction won't match it). Scrub an allowlist of
      sensitive vars (`*_API_KEY*`, `HARNESS_REMOTE_TOKEN`, …) from the child env.
- [ ] 🔵 **`BackgroundJobs.jobs` map is never reaped** (`exec/background.ts:78`):
      every finished job keeps its ≤256KB×2 buffers for the session's life. Reap
      old `exited`/`killed` jobs or cap the count.
- [ ] 🔵 **`exec()` buffers all stdout+stderr in RAM** (`host-execution.ts:103`)
      before the pipeline can spill — a multi-GB command can OOM (background jobs
      are capped; foreground exec is not). Consider a capture cap.
- [ ] 🔵 `spillLargeOutput` keeps the whole content inline *and* writes a file
      when `maxInlineChars < previewChars` (misconfig only; defaults are safe).
- [ ] 🔵 `exec` kills with SIGTERM only (no SIGKILL escalation on timeout); tool
      args are JSON-parsed twice (permission gate + registry). Both harmless.

### Block 2 — tools (fs_*, shell, background, task/subagent)

- [x] 🟡 **Sub-agent "stopped without a report".** FIXED (2026-10-14): a child
      that spent its whole budget calling tools hit `max_iterations` and the loop
      ended with no final text, so `subagent.run` returned an empty `report`
      (the TUI showed "si è fermata senza report"). `runMessages` now, on hitting
      the step limit, does ONE final **tools-less** turn (a nudge to answer in
      prose) so a report is produced — benefits top-level turns too. Belt-and-
      suspenders: `createSubagentRunner` never returns an empty report (explains
      the stop instead). Tests in `agent/test/agent.test.ts` +
      `agent/test/subagent.test.ts`.
      Follow-up (2026-10-14): the sub-agent step limit is now its own config
      knob — `subagents.maxIterations` (env `HARNESS_SUBAGENT_MAX_ITERATIONS`),
      default 50, **`-1` = unlimited** (the agent loop treats a negative limit as
      ∞). Wired in config (schema/resolve/load) + `wiring.ts`; tests in
      `config/test/resolve.test.ts` + `agent/test/agent.test.ts`.

- [x] 🟡 **`fs_edit` / `fs_multi_edit` corrupt replacements containing `$`
      patterns.** FIXED (2026-10-14): `applyOneEdit` single-match path now uses a
      function replacer `content.replace(old_string, () => edit.new_string)`, so
      `$&`/`$$`/`` $` ``/`$'` go in literally. Test added in
      `tools/test/builtins.test.ts`. 354 tests green.
- [ ] 🔵 **`explore` (read-only) sub-agent still writes spill files** to
      `.harness/tool-output/` via the result pipeline (`subagent.ts` passes
      `resultTransforms`), contradicting "cannot modify anything". Harness-internal
      + confined, but either exclude the spill write for read-only types or note it.
- [ ] 🔵 `fs_read` with `offset` past EOF yields a backwards header
      (`lines 500-499 of 10`) + empty body; `shell` labels any `exit=124` as
      "killed/timed out" even when a command legitimately exits 124.

### Block 3 — permissions & agent support (gate, shell-prefix, compact, agent-defs)

- [x] 🟡 **Auto-approve bypass: `&` is not a command separator.** FIXED
      (2026-10-14): `splitSimpleCommands` now splits on single `&` too
      (`&&|&|\|\||\||;|\n`, `&&` alternated first), so `approvedcmd & rm -rf ~`
      is two simple commands and the trailing one is no longer auto-approved.
      Tests added in `agent/test/shell-prefix.test.ts`. 356 tests green.
- [ ] 🔵 Empty-prefix shell approval is dead/misleading: when `suggestShellPrefix`
      returns `""` (command is only `VAR=val`, bare `sudo`, or empty),
      `PermissionGate.remember` falls through to `grantedTools.add("shell")`, but
      `isRemembered` never consults `grantedTools` for shell — so a session
      approval silently doesn't stick (re-asks). Fails safe, but confusing.
- [ ] 🔵 `programTokens` strips leading `sudo` in both suggest and match, so
      approving `sudo systemctl restart` creates the rule `systemctl restart`
      (and a later non-sudo `systemctl restart` auto-runs, and vice versa).
- [ ] 🔵 A throw from the permission `requester` (or `gate.authorize`) escapes
      `runMessages` uncaught, same class as Block-1 ①. The interactive requester
      resolves `allowed:false` rather than throwing, so low-risk in practice.
- [ ] 🔵 `agent-defs.ts`: `parseFrontmatter` needs `\n---\n` → a CRLF file loses
      its frontmatter silently; `tools: foo` (bare string, no `[]`) falls through
      to `"all"` instead of a single-tool list — a footgun that over-grants.
- [ ] 🔵 `compactedHistory` can leave two consecutive `user` messages (summary +
      next send); OpenAI-compatible servers tolerate it, but note for strict ones.

### Block 4 — remote (transport `RpcPeer`, daemon ws-server/connection/host)

- [x] 🟡 **Loopback daemon accepts cross-origin browser WebSockets (CSRF /
      DNS-rebinding).** FIXED (2026-10-14): extracted `originAllowed(origin,
      allowed)` (pure, exported) and wired it into `authorize` — it now
      default-denies *any* `Origin` header unless allow-listed, even on loopback
      with no token. Browsers always send `Origin`; the native CLI client sends
      none (verified in `client/src/ws-channel.ts`: only sets `Authorization`),
      so native connections still work. Tests in `daemon/test/ws-server.test.ts`:
      unit on `originAllowed` + integration (cross-origin upgrade → 401 before
      the socket; headerless → 426). 364 tests green.
- [x] 🔵 The daemon's `RpcPeer` sets no `requestTimeoutMs`, so a client that
      never answers `session/request_permission` blocks that turn forever
      (resource hold). FIXED (2026-10-14): `Connection` now takes a
      `permissionTimeoutMs` (default 5 min, from `ws-server.ts`) wired to the
      daemon peer's `requestTimeoutMs` (the only outbound daemon→client request
      is the permission ask). `requestPermission` `.catch()`es any failure
      (timeout/closed/malformed) → `{outcome:"cancelled"}` → `allowed:false`, so
      the tool is denied and the turn still ends. Test in `integration.test.ts`.
- [x] 🔵 No cap on sessions-per-connection, and `RpcPeer.receive` does
      `JSON.parse` on arbitrary-size frames — auth-gated DoS surface. FIXED
      (2026-10-14): `RpcPeer` gained `maxFrameBytes` (rejects an oversized frame
      with an InvalidRequest "frame too large" *before* parsing); `Connection`
      gained `maxSessions` (`session/new` past it → `TooManySessions`). Defaults
      in `ws-server.ts`: 8 MiB / 64 sessions, both overridable. Tests in
      `transport/test/peer.test.ts` + `daemon/test/integration.test.ts`.
- [x] 🔵 `Connection.initialize` can be re-invoked repeatedly (harmless but
      should be idempotent/guarded). FIXED (2026-10-14): a second `initialize`
      now throws `AlreadyInitialized`. Test in `integration.test.ts`. (The
      `tokensMatch` length-timing leak is left as-is — standard tradeoff, noted
      acceptable.) 368 tests green.

### Block 5 — config (resolve/load/schema)

Solid: key kept in memory only, provenance never carries the secret, precedence
clear, `.strict()` schema is deliberate. Minor notes only:

- [ ] 🔵 MCP server names (record keys) aren't charset-validated; a name
      containing `__` or odd characters could collide with / malform the
      `mcp__<server>__<tool>` tool-name convention. Validate the key shape.
- [ ] 🔵 `apiKeyCommand` failure surfaces `stderr` in the error — ensure a
      key-printing command can't leak the key there on a non-zero exit (low).

### Block 6 — TUI (App.tsx, state, render-lines, scroll, mouse, paste, run)

Reducer (`state.ts`), scroll math, mouse parsing, selection: clean and well-tested.
Findings are in the App glue and terminal lifecycle:

- [x] 🟡 **Turn-starting / session-mutating slash commands aren't guarded while
      running.** FIXED (2026-10-14): `commands.ts` `isSessionMutating` flags
      `/retry`+`/clear`; `App.handleCommand` rejects them with a notice while a
      turn runs (no concurrent `session.send`, no clobbered `abortRef`). Pure +
      ink tests (`commands.test.ts`, `app.test.tsx`).
- [x] 🔵 **Bracketed-paste can freeze input.** FIXED (2026-10-14): `stepPaste`
      gained a size cap (flush+reset on overflow) and `App` arms a 250ms recovery
      timer that flushes the capture if `[201~` never arrives. Tests in
      `paste.test.ts` + `app.test.tsx`.
- [x] 🔵 **External SIGINT/SIGTERM leaves the terminal broken.** FIXED
      (2026-10-14): extracted `terminal.ts` `installTerminalRestore` (injectable);
      `run.tsx` now restores on `exit` AND SIGINT/SIGTERM (then re-exits 128+sig).
      Tests in `terminal.test.ts`.
- [ ] 🔵 Live background-exit and `pushNotice` force `setScrollOffset(0)` (jump to
      tail) even when the user is scrolled up reading history — yanks them down.
- [ ] 🔵 `queued` (steering) list is unbounded: queueing many tasks grows the
      bottom area past the terminal height while running (viewport clamps at 3).
- [ ] 🔵 After the Block-1 ① fix, a cancelled turn just stops silently — consider
      a subtle `⎿ cancelled` notice so the user sees it was interrupted, not done.
- [ ] 🔵 (aesthetic) diff bars pad to width by character count, not display
      width, so CJK/emoji lines misalign the full-width background bars.

Daily-driver work (done 2026-10-14):
- [x] **App.tsx decomposition (partial).** Extracted cohesive, unit-tested units
      out of the 908-line god component: `useLineEditor` (+pure `editor.ts`),
      `usePermissionBroker` (+`permission-ui.ts`), `usePaintScheduler`, and the
      paste-recovery helpers. Remaining (deliberate, own pass): the mode-based
      input router + the mouse-stream state machine (tightly coupled to layout).
- [x] **Multi-line prompt + newline-preserving paste.** Pastes keep their
      newlines (was flattened to spaces — a daily papercut for code); the input
      box renders multi-line, windowed around the cursor (`input-view.ts`,
      capped at 10 rows); `\`+Enter inserts a newline, Enter submits. Tests in
      `input-view.test.ts`, `app.test.tsx`.
- [x] **Session persistence + `--resume`.** Sessions save as JSON under
      `<configDir>/sessions/<uid>.json` after every turn/compaction
      (`JsonSessionStore`, `Session.onPersist`); `agent-harness --resume [uid]`
      reopens one (latest if no uid) and restores its transcript
      (`messagesToItems`). Tests in `session-store.test.ts`, `session.test.ts`,
      `resume.test.ts`.

### Block 7 — MCP (client, stdio transport, tool adapter)

- [x] 🟡 **MCP tool calls have no timeout and ignore the turn's abort signal.**
      FIXED (2026-10-14): `McpClient.request` now takes `{signal, timeoutMs}`;
      `callTool` defaults to a 120s per-call timeout and the adapter threads
      `ctx.signal`. On timeout/abort it rejects *and* sends
      `notifications/cancelled` so the server stops. Tests in `client.test.ts`,
      `tool-adapter.test.ts`.
- [x] 🔵 MCP server `stderr: "inherit"` prints over the TUI's alt-screen. FIXED
      (2026-10-14): `transport.ts` now spawns with `stderr:"pipe"`, drains it, and
      routes lines to an optional `onStderr` (dropped by default) — threaded via
      `ConnectOptions.onStderr`.
- [x] 🔵 MCP server subprocess inherits the full `process.env` (API keys). FIXED
      (2026-10-14): spawns now use `scrubSensitiveEnv(process.env)` (new shared
      `@agent-harness/core` helper, denylist of `*API_KEY*`/`*TOKEN*`/`*SECRET*`
      /…); the user's explicit `spec.env` is still honoured. The **shell** env
      leak (Block-1 ②) can now reuse this same helper. Test in `core/test/env.test.ts`.
- [x] 🔵 `McpClient.handleMessage` silently drops inbound server requests. FIXED
      (2026-10-14): an inbound *request* (method + id) we don't implement now gets
      a JSON-RPC `-32601` reply instead of hanging the server; notifications are
      still ignored. Test in `client.test.ts`.

## Roadmap (ordered)

- [x] **Local daemon on a worker thread** (the "TUI always over RPC" lever —
      moves model streaming + tool execution off the render thread, so the UI
      never janks and a daemon crash doesn't kill the UI). **DONE and now the
      DEFAULT (2026-10-14).** `agent-harness -i` runs on the worker; opt out with
      `--in-process` (alias `--no-worker`); any worker failure still falls back
      to in-process. MCP tools + live background-job exits now work over the RPC
      boundary (the two gaps that had kept it opt-in — see below).
      - `transport/src/port-channel.ts` — `messagePortChannel` (`DuplexChannel`
        over a MessagePort/Worker) + tests (real `RpcPeer` round-trip over a
        `MessageChannel`).
      - Protocol: `session/snapshot` (read history back) + a resume-seed
        (`messages`) and client-chosen `sessionId` on `session/new`, so the
        **main thread keeps the JSON store** (decision taken) while the daemon
        owns the live conversation. Wired through `Connection`/`HostedSession`/
        `SessionHost` and `RemoteClient`/`RemoteSession`.
      - `cli/src/worker.ts` (worker entry: builds the agent from `HarnessConfig`,
        hosts one `Connection` on the worker port) + `cli/src/local-runtime.ts`
        (`persistingController` snapshots+persists after each turn/compact;
        `createLocalRuntime` + `startWorkerRuntime` with an 8s handshake timeout).
      - `main.ts`: the worker daemon is the default; **any failure falls back
        to the in-process path** (so it never breaks the TUI). Round-trip proven
        in-memory in `cli/test/local-runtime.test.ts` (persist + resume + stable uid).
      - **MCP in the worker (DONE 2026-10-14):** `worker.ts` connects MCP once on
        the worker side and registers the tools into every session's registry,
        including servers that resolve after the first session is built (no
        handshake/slow-server race). MCP connection errors ride back as an object
        message (ignored by `messagePortChannel`) and are logged by the main.
      - **Live background-job exits over the wire (DONE 2026-10-14):** new
        `background_exit` `SessionUpdate` variant (protocol); `HostedSession`
        subscribes to the session's `JobController.onExit` and streams it via the
        sink (idle or mid-turn); `RemoteClient.onBackgroundExit` routes it to a
        session-independent listener; `local-runtime` exposes a read-only
        `JobController` view (`onExit` only) that `main.ts` passes to the TUI, so
        the worker path renders job exits exactly like in-process (deduped by job
        id in `tui/src/state.ts`). Real-worker smoke test in `cli/test/worker.test.ts`
        (spawn + handshake + scripted turn); job-exit round-trip in
        `cli/test/local-runtime.test.ts`.
      - **Not covered by tests:** a real MCP subprocess in the worker (the
        registration path mirrors the tested in-process `connectConfiguredMcp`;
        spawning a live MCP server in a unit test is out of scope).
- [x] **Autonomous wake on job-exit (DONE 2026-10-14, DEFAULT ON).** When a
      background job exits while the agent is idle, the TUI auto-starts a
      continuation turn so the model reacts without a user prompt.
      - Mechanism: `Session.send("")` is a **continuation** — runs a turn over
        existing history WITHOUT appending a user message, so the agent's
        `flushBackgroundExits` note (injected at turn start) is what the model
        reacts to. Threads over RPC with no protocol change (empty prompt).
      - App (`tui/src/App.tsx`): `jobs.onExit` now, when `autoWakeOnJobExit`,
        starts a continuation (`run("", {continuation})` → `startContinuation`,
        no user bubble) if idle, or defers via `wakePendingRef` until the running
        turn settles (the running turn can't see the exit — flush is at turn
        start). Multiple exits coalesce (the agent drains all pending at once).
      - Works in BOTH paths: in-process (real `jobs`) and worker (the daemon
        streams the exit → client jobs view → same wake). Kill-switch: config
        `autoWake` (env `HARNESS_AUTO_WAKE`), default true.
      - Tests: `agent/test/session.test.ts` (empty send = continuation, no empty
        user msg, reacts to a pending exit); `tui/test/auto-wake.test.tsx` (idle
        exit → turn runs; toggle off → notice only); `config/test/resolve.test.ts`.
      - **Known limit (follow-up):** no hard wake-loop guard beyond "only when
        idle" + coalescing — a turn that itself spawns a job that exits will wake
        again (usually desired; could runaway on a pathological agent). Consider a
        consecutive-auto-wake cap without intervening user input.
- [~] **F4 — Pod execution** (`--pod --namespace <ns>`): run the agent inside a
      k8s pod (the sandbox), driven from the local TUI. Self-contained (no
      kubectl/oc — direct API via kubeconfig + the `v4.channel.k8s.io` exec WS)
      with a **reverse-tunnel for the model over the RPC channel** so the local
      endpoint/secret never leave the laptop. Reuses the whole client/daemon/RPC
      stack (new transport + lifecycle only). Full design + slice plan in
      `docs/F4-pod-execution.md`. MVP = F4.a–F4.d.
      - [x] **F4.a — `KubeClient` REST** (2026-10-14): new `@agent-harness/k8s`
        package — `createPod`/`getPod`/`deletePod`/`waitForReady`/`podIsReady`,
        bearer auth, injectable `fetch`, mock-API tests. Dependency-free.
      - [ ] **F4.a.2 — kubeconfig + TLS auth**: parse `~/.kube/config` (YAML dep),
        CA/client-cert/bearer/exec-plugin → a resolved `KubeClientOptions`.
      - [x] **F4.b — exec WS channel + `serve --stdio`** (2026-10-14):
        `transport` `streamChannel` (newline-delimited byte-stream channel) +
        `startStdioDaemon`; k8s `exec-frame` (`encodeStdin`/`ExecDemux`),
        `exec-channel` (`execChannel`/`buildExecUrl`/`execSubprotocols`) +
        `KubeClient.openExec`. Deterministic tests (framing, re-chunk, fake-WS,
        real `RpcPeer` handshake over a stream pair).
      - [x] **F4.c — `startPodRuntime` + `--pod`/`--namespace`/`--image`**
        (2026-10-14): `buildPodManifest` (keepalive container; daemon exec'd in)
        + `startPodRuntime` (create→ready→openExec(serve --stdio)→
        createLocalRuntime; dispose closes + deletes the pod) + `main.ts --pod`.
        Auth stopgap: `HARNESS_K8S_SERVER`/`_TOKEN` env (kubeconfig = F4.a.2).
        End-to-end tested over an in-memory channel to a real Connection.
      - [ ] **F4.d — reverse-tunnel model proxy** (`model/stream` + proxy provider).
- [ ] **Skills support** — packaged procedural guidance the model opts into
      (complementary to the result pipeline: skills = *how to do it*, the pipeline
      = *the guarantee the context stays clean*).

## File tools

- [x] **`fs_multi_edit`** — apply several exact-string edits to one file in a
      single call, in order, atomically (Claude-Code style).
- [x] **`fs_read` line ranges** — read a slice via `offset`/`limit` or a
      `path:start:end` suffix instead of the whole file, then edit precisely.

## Result-pipeline transforms

Built on the `ResultTransform[]` pipeline (`packages/agent/src/result-pipeline.ts`),
wired in order: redact → dedup → tabulate → (summarize | spill).

- [x] **`spillLargeOutput`** — spill a too-large tool result to
      `.harness/tool-output/<tool>-<id>.txt` and keep only a preview + pointer
      in-context. Configurable via `tools.maxInlineOutputChars`.
- [x] **`redact`** — mask secrets / API keys / tokens in tool output before it
      enters the context (and before it is spilled to disk). On by default
      (`tools.redactSecrets`).
- [x] **`summarize`** — replace large output with an LLM summary (full content
      spilled to a file). Opt-in (`tools.summarizeLargeOutput`, costs a model call).
- [x] **dedup** — collapse runs of identical consecutive lines. On by default
      (`tools.dedupOutput`).
- [x] **structured result** — render a JSON array-of-objects result as a compact
      table. Opt-in (`tools.tabulateJson`).

## Context budget (ties in with `/compact`)

- [ ] **Budget-aware spill** — lower the spill threshold as the context meter fills.
- [ ] **Auto-compact** — compact automatically above a fill threshold (manual
      `/compact` already exists).

## Output / file handling

- [ ] **File-handle registry** — hand the model handles (e.g. `#out1`) instead of
      raw paths, expandable via a dedicated `read_output(handle, grep|offset)` tool.
- [ ] **Anchors / citations** — include the line range in a spilled file's preview
      so the model can `fs_read offset/limit` precisely.

## Targeted guidance (not system-prompt bloat)

- [ ] **One-shot contextual hints** — a short note only the first time a tool
      exceeds a threshold, not every turn.

## Earlier deferrals (from prior slices)

- [ ] **MCP**: SSE/HTTP transport; resources & prompts; MCP in the `serve` daemon.
- [ ] **Sub-agents**: background / parallel execution (SA.d).
- [ ] **F2**: container execution environment (behind the existing
      `ExecutionEnvironment` contract).
- [ ] **Remote control (F3)**: heartbeat/idle-timeout/reconnect, multi-client
      observers, `config.jsonc` `remote` block, operator docs.
- [ ] Add `.harness/` to the workspace `.gitignore` guidance (spilled output).
- [ ] Git: the repo still has no commits (commit only on explicit OK).
