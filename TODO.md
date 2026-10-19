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
- [x] 🔵 **Shell inherits the full `process.env`** — FIXED (2026-10-17):
      both `Bun.spawn` sites (`host-execution.ts`) now hand the child
      `childEnv(options)` = `scrubSensitiveEnv(process.env)` with the caller's
      explicit `options.env` overlaid unscrubbed (opt-in, same policy as the MCP
      stdio transport). Red-first tests in `exec/test/host-execution.test.ts`
      (leak absent + `PATH` present, `exec` and `spawnBackground`; explicit
      overlay honoured). **Fix:** `docs/fix/shell-env-scrub.md`.
- [x] 🔵 **Shared env denylist misses this repo's own pod-TLS vars** — FIXED
      (2026-10-17): `SENSITIVE_KEY` (`core/src/env.ts:11-12`) gains a
      `TLS[_-]?(KEY|CERT|CA)` fragment, so `TENTACLE_POD_TLS_KEY` / `_CERT` /
      `_CA` are scrubbed from the shell + MCP children (the two `scrubSensitiveEnv`
      sites); `TENTACLE_POD_TLS_INSECURE` stays (a flag, not a secret) and the
      delete child is untouched (it never scrubs — it builds its TLS env
      explicitly, `k8s/src/pod-cleanup.ts:173-186`). Red-first + mutation-checked
      tests in `core/test/env.test.ts`. **Fix:** `docs/fix/pod-tls-env-scrub.md`
      (promoted from the eval on the owner's OK).
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
- [ ] 🟡 **Oversize / degenerate tool-call guard (anti-runaway).** A real
      incident (2026-10-16): the local model repetition-looped emitting `"` and
      produced an `fs_multi_edit` tool-call with **167,794-char arguments** →
      the upstream (llama.cpp) returned `500 "parse error col 167795"`, and that
      monster call **poisoned the session file** (had to remove messages 169/170
      by hand with `jq`). One degenerate model loop broke the whole session.
      **Guard, at the harness** (NOT the sampler — a DRY repetition penalty was
      tried and reverted because it breaks `fs_edit`'s verbatim reproduction of
      existing code): when a tool-call's assembled arguments exceed a sane cap
      (and/or show degenerate repetition — a short sequence repeated N× ), reject
      the call *before* executing or persisting it and return an actionable
      tool-error to the model so it can recover, instead of attempting the call
      and saving a corrupt turn. Lives in the tool-call parse/validate path
      (agent loop / provider SSE assembly where `tool_call` args accumulate).
      Precedent: the daemon already caps inbound RPC frames (`maxFrameBytes`,
      Block 4) — this is the analogous cap one layer up, on model output.
      Keeps normal editing untouched. Plan not yet written.

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
      knob — `subagents.maxIterations` (env `TENTACLE_SUBAGENT_MAX_ITERATIONS`),
      default 50, **`-1` = unlimited** (the agent loop treats a negative limit as
      ∞). Wired in config (schema/resolve/load) + `wiring.ts`; tests in
      `config/test/resolve.test.ts` + `agent/test/agent.test.ts`.

- [x] 🟡 **`fs_edit` / `fs_multi_edit` corrupt replacements containing `$`
      patterns.** FIXED (2026-10-14): `applyOneEdit` single-match path now uses a
      function replacer `content.replace(old_string, () => edit.new_string)`, so
      `$&`/`$$`/`` $` ``/`$'` go in literally. Test added in
      `tools/test/builtins.test.ts`. 354 tests green.
- [ ] 🔵 **`explore` (read-only) sub-agent still writes spill files** to
      `.tentacle/tool-output/` via the result pipeline (`subagent.ts` passes
      `resultTransforms`), contradicting "cannot modify anything".
      Tentacle-internal + confined, but either exclude the spill write for
      read-only types or note it.
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

- [ ] 🟡 **Worker daemon swallows its own errors → TUI shows bare `RpcError:
      internal error`.** SEEN TWICE on 2026-10-16, both in the local (worker,
      no pod) TUI, both right after a `Read` tool result rendered in the TUI
      (second time: after reading `packages/agent/src/agent.ts`, a 434-line
      file). Chain: the worker's RPC request handler throws a NON-`RpcError`
      → `transport/peer.ts:209` converts it to the generic
      `InternalError(-32603, "internal error")` for the client AND calls
      `reportError` → `onError` — but `cli/src/worker.ts:92` builds its
      `Connection` with NO `onError`, so the real error is dropped and the TUI
      (client side) only ever sees the generic message. ROOT CAUSE UNKNOWN
      (no daemon-side log exists to look at). Suspect: a handler that throws on
      a large tool result / `session/update` payload (both crashes followed a
      big `Read`), or the client's inbound result validation
      (`peer.ts:258`, "invalid result for …") — but neither is confirmed.
      **Observability shipped (2026-10-16) — the error is no longer lost
      (root cause still OPEN):** the worker's `Connection` now wires `onError`
      → `logDaemonError` (`cli/daemon-log.ts`), appending the real message +
      **stack** to `<configDir>/logs/daemon-errors.log` (append-only, ISO
      timestamped; a FILE, not stdout, so it can't corrupt the TUI mid-session).
      AND, because the worker is a local/trusted peer, `Connection` is built
      with `exposeInternalErrors: true` (new `RpcPeerOptions`/`ConnectionOptions`
      flag): a non-`RpcError` handler throw now sends the REAL message (+ stack
      in `data`) to the client instead of the opaque "internal error", so the
      TUI line itself shows the actual cause. Default stays opaque — the remote
      `ws-server` path does NOT set the flag (no leak to untrusted clients).
      Tests: `transport/test/peer.test.ts` (expose on → real message+stack; off
      → generic), `cli/test/daemon-log.test.ts`.
      **When it recurs:** grab `~/.config/tentacle/logs/daemon-errors.log`
      (or the configured `configDir`) — it now has the stack — and/or screenshot
      the (now real) TUI error line, then diagnose. Still TODO: the same
      generic-conversion gap on `ws-server.ts:182` is intentionally left (remote
      = untrusted); a server-side error log there is a possible follow-up.
- [ ] 🟡 **Mid-turn "Queue a task…" (steering) silently no-ops on the worker
      and pod paths (pre-existing gap, surfaced 2026-10-16).** The TUI's
      mid-turn input calls `sessionRef.current?.enqueue(text)` (`tui/App.tsx:451`,
      OPTIONAL — a no-op when absent), but `enqueue` exists only on the local
      `Session` (`agent/src/session.ts:83`). The worker and pod runtimes wrap a
      `RemoteSession` in `persistingController` (`cli/local-runtime.ts`) which
      exposes no `enqueue`, and the daemon explicitly drops `steer` updates
      (`daemon/mapping.ts:108`: "Steering is a local-TUI interaction; not yet
      wired over the wire"). So on the DEFAULT (worker) path and on `run`/
      `exec`, a task typed mid-turn is silently dropped (the input line
      empties, nothing is queued). Only `--in-process`/`--no-worker` (and the
      worker-failure fallback) queue it. Surfaced when a mutation-test
      leftover in `local-runtime.ts` (`allowAll` unimported → `ReferenceError`
      on the worker handshake) was forcing the in-process fallback — while that
      broken state existed, steering "worked" because the fallback had the real
      `Session`; after the revert, the worker path is active again and the
      pre-existing gap is visible. NOT caused by the `exec` refactor (the
      worker/in-process blocks in `main.ts` are untouched).
      **Implementation plan: `docs/fix/steering-over-rpc.md`** — add a
      `session/enqueue` request (client → daemon `Session.enqueue`) and stream
      the agent's `steer` event back over `session/update` (new `steer`
      update variant; the TUI already clears the ⏳ line on it). Additive
      protocol change (version stays 1): a new method is `MethodNotFound`
      for old clients that never call it, and new update variants are ignored
      by old clients (union members are non-`.strict()`). 10 files + 5 test
      files; see the doc for the full per-file spec. Not yet implemented.
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
- [ ] 🟡 **A dropped connection leaks the raw Bun socket error into the TUI.** A
      transport close mid-turn (candidate sources: the model-provider
      `fetch`/SSE stream, an MCP connection, or the local worker channel)
      surfaces verbatim as
      `⚠ Error: The socket connection was closed unexpectedly. For more
      information, pass verbose: true in the second argument to fetch()`
      because `App.tsx:326` does `failTurn(state, String(error))` with no
      mapping. Future iteration: catch transport/network close errors at the
      `session.send()` boundary and surface a clean "connection to the
      provider/daemon dropped — retry the turn?" notice instead of the raw
      message; decide on auto-retry / reconnect semantics. (Reported 2026-10-14
      in a local TUI session — **not** k8s/pod related.)

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
      (`JsonSessionStore`, `Session.onPersist`); `tentacle --resume [uid]`
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
      `@tentacle/core` helper, denylist of `*API_KEY*`/`*TOKEN*`/`*SECRET*`
      /…); the user's explicit `spec.env` is still honoured. The **shell** env
      leak (Block-1 ②) can now reuse this same helper. Test in `core/test/env.test.ts`.
- [x] 🔵 `McpClient.handleMessage` silently drops inbound server requests. FIXED
      (2026-10-14): an inbound *request* (method + id) we don't implement now gets
      a JSON-RPC `-32601` reply instead of hanging the server; notifications are
      still ignored. Test in `client.test.ts`.

### Block 8 — cross-cutting audit (2026-10-17, each verified by a fresh-context sub-agent repro)

- [ ] 🔴 **Pod `--model-proxy`: cancel doesn't stop the model, and the requested
      tool still runs.** `ProxyModelProvider` ignores `signal`; no `model/stream`
      cancel; the agent loop never re-checks `aborted` between stream end and tool
      execution. CONFIRMED. **Eval:** `docs/eval/proxy-model-cancel.md`.
      Type: eval · Size: M · Blast: load-bearing. **Model half fixed** by
      `fix/pod-model-streaming` (2026-10-18); the tool-execution half is open.
- [x] 🔴 **`/compact` with an empty summary wipes the history** (reasoning-only
      model, or an in-band SSE `{"error":…}` chunk) and persists it. CONFIRMED.
      **FIXED (merged to main):** `docs/fix/compact-empty-summary-wipe.md` —
      `summarizeConversation` throws `CompactError` on an empty summary, so
      `Session.compact` rejects pre-mutation/pre-persist (history intact in
      memory and on disk, all runtimes). Type: fix · Size: S · Blast: cross-module.
- [ ] 🟡 **Remote `/compact` failure shows an opaque `internal error`** (worker
      surfaces the real `CompactError` via `exposeInternalErrors`, but a remote
      `connect` omits the flag — `ws-server.ts:182-187` — so the client gets
      `RpcError: internal error` and the TUI prints `Compact failed: internal
      error`). Correct (history is safe) but unhelpful; fix = a dedicated
      additive `DomainErrorCode` (e.g. `EmptySummary`) mapped to an `RpcError`
      so the message crosses the wire without leaking internals (protocol
      version stays 1). Second review pass, Finding 4, of
      `docs/fix/compact-empty-summary-wipe.md`. Type: feat · Size: S ·
      Blast: cross-module.
- [ ] 🟡 **`session/compact` races a turn on the daemon** (both directions: compact
      mid-turn → orphan `tool` msg; prompt mid-compact → turn silently lost).
      CONFIRMED. **Eval:** `docs/eval/daemon-compact-turn-guard.md`. Type: eval ·
      Size: S · Blast: load-bearing.
- [ ] 🟡 **No daemon session lifecycle**: background jobs orphaned on `/clear` /
      disconnect / exit; duplicate `sessionId` clobbers; `shell_kill` misses
      grandchildren. CONFIRMED. **Eval:** `docs/eval/daemon-session-lifecycle.md`.
      Type: eval · Size: M · Blast: load-bearing.
- [ ] 🟡 **No history-validity invariant** (dangling tool_calls / invalid-JSON args
      persisted and re-sent; resume repairs nothing). CONFIRMED (mostly).
      Subsumes the Block-3 requester-throw + consecutive-user items.
      **Eval:** `docs/eval/history-validity-invariant.md`. Type: eval · Size: M ·
      Blast: load-bearing.
- [ ] 🟡 **Session store not crash-safe** (in-place write truncates; failed `void
      save` crashes the TUI; corrupt files vanish from `--resume`; no schema
      check). CONFIRMED. **Eval:** `docs/eval/session-store-durability.md`.
      Type: eval · Size: M · Blast: load-bearing.
- [ ] 🟡 **Worker death after handshake hangs the TUI forever** (Bun fires
      `close`; nobody listens). CONFIRMED. **Eval:** `docs/eval/worker-crash-hang.md`.
      Type: eval · Size: S · Blast: contained.
- [ ] 🟡 **Truncated tool-call persisted when the SSE stream ends before
      `finish_reason`** (Esc abort is NOT a trigger in practice). PARTIALLY
      CONFIRMED. **Eval:** `docs/eval/sse-abort-truncated-toolcall.md`.
      Type: eval · Size: S · Blast: cross-module.
- [ ] 🔵 **Oversize (8–16 MiB) frame on `connect` hangs the request** (null-id
      error can't be correlated). PARTIALLY CONFIRMED (the `--resume` trigger was
      wrong). **Eval:** `docs/eval/oversize-frame-hang.md`. Type: eval · Size: S ·
      Blast: cross-module.
- [ ] 🟡 **Anthropic provider drops `thinking` blocks instead of echoing them
      back.** Quality-only or a hard 400 in tool loops: undetermined, needs a live
      test. **Eval:** `docs/eval/anthropic-thinking-echo.md`. Type: eval · Size: M ·
      Blast: cross-module.
- [ ] 🟡 **No retry on a transient model-connection drop** (`ECONNRESET` kills
      the turn and the sub-agent; only manual `/retry`), and the error log says
      `(no stack)` with no phase. Recommends retry pre-first-byte only + phase
      diagnostics. **Eval:** `docs/eval/model-connection-resilience.md`.
      Type: eval → feat · Size: M · Blast: load-bearing.
- [ ] 🟡 **`shell_kill` leaves grandchildren running** (only `sh` gets the signal;
      a compound command's child is re-parented to PID 1). Found during the
      lifecycle eval — see `docs/eval/daemon-session-lifecycle.md`.
- [ ] 🟡 **OpenAI provider treats an in-band SSE `{"error":…}` chunk as an empty
      stream** (HTTP 200, no throw), so callers see a silent empty response (e.g.
      `/compact` wiping history). See `docs/fix/compact-empty-summary-wipe.md`
      (the wipe is guarded there; this provider defect — which also affects
      normal turns — is the separate follow-up).
- [ ] 🟡 **A failed session save crashes the TUI** (`void store.save` rejects →
      unhandled rejection → exit 1 with a raw stack). See
      `docs/eval/session-store-durability.md`.
- [ ] 🟡 **`--resume` (no uid) resumes another project's session**:
      `store.latest()` ignores the launch cwd. Move to
      `~/.config/tentacle/sessions/<cwd-key>/<uid>.json`. CONFIRMED.
      **Eval:** `docs/eval/session-store-per-project.md`.
      Type: eval → fix · Size: M · Blast: load-bearing.

### Block 10 — remote execution model (pod mode: what runs where; 2026-10-17, measured on OCP)

Umbrella and order: `docs/eval/remote-execution-model.md` (proposes a new §7
invariant: "compute next to the code, identity with the user; a pod is not
trusted"). Do them in order. `docs/fix/steering-over-rpc.md` goes right after 1.

- [x] 🔴 **1. Pod mode shows nothing until the whole model round ends** (47 s of
      silence measured, then 6,480 events at once; Esc doesn't stop the model).
      **Fix:** `docs/fix/pod-model-streaming.md` — done 2026-10-18: first token
      0.22 s on kind, Esc stops the laptop model; `model/streamChunked` +
      generic `$/progress` / `$/cancelRequest`. Type: fix · Size: M · Blast:
      load-bearing.
- [ ] 🟡 **2. A large payload blocks every other message on the channel** (5 MB
      → ~4 s head-of-line; an end-to-end window W=2×256 KB bounds it to ~0.25 s).
      **Eval:** `docs/eval/rpc-flow-control.md`. Needs 1. Type: eval → feat ·
      Size: M–L · Blast: load-bearing.
- [ ] 🟡 **3. `runOn: "client"` — laptop MCP servers usable by the pod daemon**
      (push `tools/register`, `tool/call`, laptop-side gate). **Eval:**
      `docs/eval/mcp-client-tools.md`. Needs 1 (hard), 2 (soft), §7 invariant.
      Type: eval → feat · Size: L · Blast: load-bearing.
- [ ] 🟡 **4. `runOn: "daemon"` — workspace MCP servers started in the pod**
      (placeholder-only secrets, process-group dispose). **Eval:**
      `docs/eval/mcp-daemon-servers.md`. Type: eval → feat · Size: M · Blast:
      load-bearing.

### Block 11 — editor integration (ACP; 2026-10-19)

- [ ] **Tentacle is not usable from ACP editors (Zed)**: our wire is
      ACP-shaped but not ACP-compatible, and there is no `tentacle acp`. Proposal:
      an adapter frontend over `createLocalRuntime` (no wire change).
      **Eval:** `docs/eval/acp-adapter.md`. Type: eval → feat · Size: M (v1) ·
      Blast: load-bearing.

### Block 9 — open legacy plans (moved out of `docs/` root, 2026-10-17)

Pre-§10 docs with no TODO entry until now; not sized yet (size them when picked up).

- [ ] 🟡 **`tentacle attach` dies after idle** (`⚠ RpcError: peer is closed`):
      the exec channel has no keepalive or reconnect. **Plan:**
      `docs/feat/pod-attach-resilience.md`. Type: feat.
- [ ] **Self-deleting injected binary on `attach`** (leave-no-trace on a
      user-owned pod). **Eval:** `docs/eval/pod-ephemeral-binary.md`. Type: eval.
- [ ] **React 18 → 19 + Ink 5 → 8** (want-driven, retires two workarounds).
      **Eval:** `docs/eval/react-19-migration.md`. Type: eval.

## Roadmap (ordered)

- [x] **Local daemon on a worker thread** (the "TUI always over RPC" lever —
      moves model streaming + tool execution off the render thread, so the UI
      never janks and a daemon crash doesn't kill the UI). **DONE and now the
      DEFAULT (2026-10-14).** `tentacle -i` runs on the worker; opt out with
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
      - `cli/src/worker.ts` (worker entry: builds the agent from `TentacleConfig`,
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
- [x] 🔴 **Compiled binary drops the worker daemon — 8s "handshake timed out",
      silent in-process fallback.** FOUND 2026-10-14, **FIXED 2026-10-14** (on
      branch `fix/compiled-worker-spawn`, after upgrading Bun to **1.4.3**).
      Fix = keep the `new Worker(new URL("./worker.ts", import.meta.url).href)`
      form + list `worker.ts` as a **second build entrypoint** (`scripts/build.ts`)
      + **Bun ≥ 1.4.3** (on 1.4 the URL form resolves against embedded
      entrypoints). `startWorkerRuntime` also gained a worker `error` listener so
      a spawn failure now logs the real cause instead of the generic 8s timeout.
      Verified end-to-end: the 1.4.3 binary contains the embedded worker
      bootstrap, boots with `ready` on line 1 and **0 fallback lines**.
      Running the **compiled** `dist/tentacle -i` (vs.
      `bun packages/cli/src/main.ts`) prints `[worker] handshake failed (Error:
      worker handshake timed out after 8000ms); using in-process` before the TUI.
      From **source** the same config boots the worker in ~20ms, so this is
      specific to the `bun build --compile` executable — and the in-process
      fallback masks it, so nothing looks broken.
      - **Root cause (repro'd in an isolated mini-project):** in a compiled
        binary the worker is not part of the bundle, so
        `new Worker(new URL("./worker.ts", import.meta.url).href)` fails at
        spawn with `BuildMessage: ModuleNotFound resolving
        "/$bunfs/root/worker.ts" (entry point)` (`/$bunfs` = the embedded
        virtual FS). `startWorkerRuntime` (`cli/src/local-runtime.ts`) never
        listens for the worker's `error` event, so the failure surfaces only as
        the 8s handshake timeout, then the in-process fallback.
      - **What does NOT work (Bun 1.3.14):**
        - `compile.workers: ["worker.ts"]` — same `ModuleNotFound`.
        - `worker.ts` as a **second entrypoint** + the **URL form**
          (`new URL(…)` / `.href`) — same `ModuleNotFound`. (Current Bun docs
          say the URL form "will work" once the worker is a listed entrypoint —
          true on a newer Bun, NOT on 1.3.14.)
      - **What half-works — and is a REGRESSION, do not ship:** `worker.ts` as a
        second entrypoint + a **plain relative string** `new Worker("./worker.ts")`.
        In a compiled binary this resolves the embedded entrypoint and the real
        binary boots clean (verified: no fallback line, `ready` immediate). BUT
        from **source/tests** the string form resolves relative to the **CWD**
        (not the module), so `bun test` (CWD = repo root) → `./worker.ts` =
        `<root>/worker.ts` (missing) → `cli/test/worker.test.ts` times out
        (passed in 21ms on `main` with the URL form). *Leading hypothesis — to
        confirm:* the "real worker" vs "trivial worker" delta I first suspected
        is actually just this CWD-vs-module resolution, not the imports.
      - **Root cause (confirmed):** it was specifier resolution, NOT the
        import graph. The string form resolves against the **CWD** from source
        (breaks `bun test`) but against embedded entrypoints in a compiled
        binary; the URL form is the reverse. No single specifier works in both
        environments on Bun 1.3 — but on **Bun 1.4** the URL form works in
        both (verified: `new URL(…)` + 2nd entrypoint, compiled 1.4.3 mini-repro
        → worker boots).
      - **Done (2026-10-14):** Bun upgraded to 1.4.3 and `engines.bun` bumped
        to `>=1.4.3` (the compiled-binary worker path needs it; source runs
        fine on 1.3, but keeping the floor simple). Interim behaviour is safe
        regardless: the TUI still works via the in-process fallback;
        `--in-process` / `--no-worker` is the explicit escape hatch.
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
        `autoWake` (env `TENTACLE_AUTO_WAKE`), default true.
      - Tests: `agent/test/session.test.ts` (empty send = continuation, no empty
        user msg, reacts to a pending exit); `tui/test/auto-wake.test.tsx` (idle
        exit → turn runs; toggle off → notice only); `config/test/resolve.test.ts`.
      - **Known limit (follow-up):** no hard wake-loop guard beyond "only when
        idle" + coalescing — a turn that itself spawns a job that exits will wake
        again (usually desired; could runaway on a pathological agent). Consider a
        consecutive-auto-wake cap without intervening user input.
- [~] **F4 — Pod execution** (`run --image <ref> [--namespace <ns>] [<name>]`): run the agent inside a
      k8s pod (the sandbox), driven from the local TUI. Self-contained (no
      kubectl/oc — direct API via kubeconfig + the `v4.channel.k8s.io` exec WS)
      with a **reverse-tunnel for the model over the RPC channel** so the local
      endpoint/secret never leave the laptop. Reuses the whole client/daemon/RPC
      stack (new transport + lifecycle only). Full design + slice plan in
      `docs/architecture/F4-pod-execution.md`. MVP = F4.a–F4.e.
      - [x] **F4.a — `KubeClient` REST** (2026-10-14): new `@tentacle/k8s`
        package — `createPod`/`getPod`/`deletePod`/`waitForReady`/`podIsReady`,
        bearer auth, injectable `fetch`, mock-API tests. Dependency-free.
      - [x] **F4.a.2 — kubeconfig + TLS auth** (2026-10-14): `kubeconfig.ts`
        (pure parse+resolve, `yaml` dep) + `kube-auth.ts` `loadKubeClientOptions`
        (CA/client-cert/bearer/exec-plugin → `KubeClientOptions` with TLS-aware
        fetch/WebSocket via Bun's per-call `tls`). `run` resolves from the
        kubeconfig by default. Validated LIVE from a real kind kubeconfig with
        client-cert mTLS (Bun honours `tls.{ca,cert,key}` on fetch AND WebSocket).
      - [x] **F4.b — exec WS channel + `serve --stdio`** (2026-10-14):
        `transport` `streamChannel` (newline-delimited byte-stream channel) +
        `startStdioDaemon`; k8s `exec-frame` (`encodeStdin`/`ExecDemux`),
        `exec-channel` (`execChannel`/`buildExecUrl`/`execSubprotocols`) +
        `KubeClient.openExec`. Deterministic tests (framing, re-chunk, fake-WS,
        real `RpcPeer` handshake over a stream pair).
      - [x] **F4.c — `startPodRuntime` + `run`/`--namespace`/`--image`**
        (2026-10-14; command renamed `--pod` → `run` with an optional
        positional pod `<name>` in 2026-10-15): `buildPodManifest` (keepalive
        container; daemon exec'd in) + `startPodRuntime` (create→ready→
        openExec(serve --stdio)→ createLocalRuntime; dispose closes + deletes
        the pod) + `main.ts run`. A missing namespace 404s the pod create and
        is translated into an actionable error (not auto-created).
        Auth stopgap: `TENTACLE_K8S_SERVER`/`_TOKEN` env (kubeconfig = F4.a.2).
        End-to-end tested over an in-memory channel to a real Connection, and
        **validated LIVE against kind** (opt-in `k8s/test/integration.live.test.ts`:
        REST + exec round-trip over TLS). Note for F4.a.2: Bun honours
        `NODE_EXTRA_CA_CERTS` for fetch AND WebSocket, so CA trust is easy.
      - [x] **F4.d — reverse-tunnel model proxy** (2026-10-14, non-streaming cut):
        protocol `model/stream` + wire schemas; daemon `ProxyModelProvider` +
        `Connection.requestModelStream`; `serve --stdio --model-proxy`; client
        `RemoteClient` serves it with the LOCAL provider; `startPodRuntime` passes
        it. Endpoint+key stay on the laptop. In-memory round-trip tested.
        Follow-up (F4.d.2): token streaming over the tunnel + mid-call cancel.
      - [x] **F4.e — pod binary injection** (2026-10-15): `run` now works
        with an image that does NOT contain `tentacle` — the binary is
        injected over the exec WebSocket before the daemon starts: `uname -m`
        arch probe (ANY failure → `bun-linux-x64`, never aborts) → bytes from
        `TENTACLE_POD_BIN` → `dist/pod-bin/` cache → `Bun.build` cross-compile
        (shared options with `bun run compile`) → raw stream via one-shot
        `sh -c "mkdir -p … && head -c N > … && chmod 755 …"` (`head -c` EOF =
        known size — no tar, no terminator) → verify with `tentacle
        --version` (glibc hint on a musl loader failure). New pieces:
        `k8s/exec-run.ts` (one-shot exec resolving on command exit),
        `cli/pod-binary.ts`, `cli/pod-binary-build.ts`, `--version` flag.
        **Constraint:** the image must be a Linux **glibc** image with
        `sh`+`head` (Bun's compiled binary is always glibc-linked; musl
        Alpine/busybox cannot run it — the probe fails with a clear error +
        hint). Validated LIVE on an x86_64 OpenShift cluster: UBI9 full
        success (89 MB transfer + daemon), busybox clean failure at the probe.
        Design + as-built log: `docs/feat/pod-binary-injection.md`.
      - [~] **F4.e.2 — read-only-rootfs pods** (2026-10-16): a hardened pod
        (`readOnlyRootFilesystem`, e.g. coredns on OCP 4.22) broke injection
        twice. FIXED: (a) `--bin-dir <dir>` / `TENTACLE_POD_BIN_DIR` installs to
        a writable+exec dir (e.g. `/tmp`) instead of `/usr/local/bin`, exec'd by
        absolute path; (b) the pod daemon (`serve --stdio`) loads config with
        `scaffold:false` — it no longer `mkdir`s `~/.config` (was `EROFS` →
        daemon dies → client sees "connection closed").
        **OPEN 🔵 residual (fully read-only pods):** `spillLargeOutput` writes a
        large tool result to `<cwd>/.tentacle/tool-output/` (`agent/agent.ts`);
        on a read-only pod cwd this write fails. Only triggers on big output (not
        startup), so attach/run work, but a tool with huge output would error.
        Fix options: make the spill best-effort (skip + keep inline on write
        failure), or spill to a writable dir (`/tmp`, or the `--bin-dir` dir).
        Not yet done.
      - [~] **F4.g — `attach` to an existing pod** (branch
        `feat/pod-exec-attach`, from `c5b7f58`):
        `tentacle attach <pod> [--namespace <ns>] [--container <c>|-c <c>]
        [--resume [uid]]` — the `run` flow minus the lifecycle: `getPod`
        (404 → actionable error, terminal phase → reject) → bounded 60 s
        readiness wait → **preflight `tentacle --version`** that skips the
        whole injection when the pod already has it (re-attach is sub-second,
        no 89 MB transfer) → same daemon exec + reverse-tunnel + persisting
        runtime. The pod is USER-OWNED: `dispose` only closes the exec channel;
        NO `deletePod`, NO exit safety net (closing the TUI detaches, the pod
        stays `Running`). New: `startExecRuntime` + `PodExecRuntimeDeps` in
        `cli/pod-runtime.ts`, `getPod` on `PodCluster`, `-c` short alias in
        `main.ts`, `containerExecError` (translates "exec channel closed before
        the command reported a status" → wrong-container hint), shared helpers
        `loadPodAuth`/`loadPodResume`/`runPodTui` in `main.ts`. Tests:
        `describe("startExecRuntime")` (9 cases) + `exec` parse case + the
        single-broker regression test under `describe("startPodRuntime")`.
        **Permission fix (validated 2026-10-15):** the `run`/`exec` refactor
        had split the `PermissionBroker` into two instances (runtime's
        default-`allowAll` auto-approved everything; the TUI prompt was never
        reached) — restored to ONE shared instance passed to both
        `startPodRuntime`/`startExecRuntime` and `startTui` (invariant
        documented on `runPodTui`). Validation at time of writing:
        typecheck 0, lint 0, 530 pass / 0 fail / 1 skip (531 total; skip =
        live k8s opt-in).
        **Pre-commit checklist (all done):**
        1. ~~**Container default (deviation from approved plan):**~~
           **FIXED:** `startExecRuntime` no longer forces `AGENT_CONTAINER` —
           `deps.container` is passed through (undefined → the exec API omits
           the `container` parameter and picks the only/default container, so
           single-container pods need no `-c`). `injectAgentBinary`/
           `probePodArch` gained an optional `container` (the `run` path still
           passes the concrete name); `containerExecError` renders
           `container "x" of pod "p"` when named, `pod "p"` when not. Tests:
           the no-container case now asserts `exec:mypod:-:…`, plus a new
           explicit-`container: "dns"` case asserting `exec:mypod:dns:…`.
        2. ~~**Regression test for the single-broker invariant:** prove
           `startPodRuntime`/`startExecRuntime` route permission requests
           through `deps.permissions` (spy requester + a turn with an `ask`
           tool in the daemon → assert the requester was called). The `main.ts`
           wiring (one instance → runtime + TUI) is the other half;
           `startTui` is Ink so it is not directly mockable.~~ **DONE:**
           `SpyFakeCluster` (daemon agent gets `fsWriteTool` — a real `ask`
           tool — with its gate wired to a SEPARATE daemon-side broker, exactly
           like production `wiring.ts`; the client-side broker is a
           `SpyBroker` passed as `deps.permissions`) + `AskModel` (one
           `tool_call` to `fs_write`, then done). Two tests (one per runtime):
           the turn's ask crosses the wire and is recorded by the spy
           (`level:"ask"`, `title:"Write a file"`, `detail:"/tmp/x.txt"`).
           Identity is the point: a client wired to a DIFFERENT broker would
           leave the spy empty (turn completes via allowAll, test fails on
           `toHaveLength(1)`). `FakeCluster.model`/`connection` became
           `protected` for the subclass. Verified NOT VACUOUS via a
           mutation-test: temporarily wiring the client to a DIFFERENT
           `PermissionBroker` (the original bug) makes both tests fail on
           `expect(spy.requests).toHaveLength(1)` (received 0 — the ask never
           reached the spied broker) — then reverted (file is byte-identical).
        3. ~~**Doc staleness:** `docs/feat/pod-exec-attach.md` §10 says "526 pass" —
           update to 527 pass / 0 fail / 1 skip (528 total) and note the
           `-c`/`containerExecError` addition.~~ **DONE (with item 1):** §3
           flow diagram (no more `?? AGENT_CONTAINER`), §10 test list (8
           cases), `-c`/`containerExecError` noted, validation line now
           528 pass / 0 fail / 1 skip.
        4. ~~**Rebuild the 3 binaries**~~ **DONE:** all three rebuilt after the
           broker + container fixes (linux-x64, linux-arm64, then macOS `dist/
           tentacle` last, ad-hoc signed); `dist/` is git-ignored, so
           nothing ships in the commit.
        5. ~~**Single commit**~~ **DONE:**
           `feat(cli): exec subcommand — attach TUI to an existing pod
           (inject-if-needed, -c container alias, no delete on exit)`.
        **Accepted debt (do not regress, optional to improve later):**
        `startExecRuntime` duplicates ~60 lines of `startPodRuntime`'s tail
        (status scaffold, injection wiring, openExec, modelProvider,
        createLocalRuntime) — the two tails differ BY DESIGN (delete vs
        no-delete, `podCreateError` vs `containerExecError`), so a shared-core
        extraction with lifecycle hooks is the only clean de-duplication;
        not worth it for this feature.
- [x] **TUI brand accent → cyan, single-sourced** (`docs/feat/tui-brand-color.md`,
      2026-10-17): for the public MIT release the TUI drops the Anthropic
      trade-dress orange `#d77757` and the permission blue `#6377ff` for one
      distinctive cyan `#06b6d4`, and the colour stops drifting — a new
      `accentHex` constant in `packages/tui/src/theme.ts` is the ONE source both
      colour paths read (chalk `theme.accent = chalk.hex(accentHex)`, `claude`
      token removed; the 5 Ink components import `accentHex`). Grep-guard: zero
      old-hex under `packages/tui/src`; new `theme.test.ts` (red first,
      mutation-verified); `bun run check` 635 pass / 1 skip / 0 fail; fresh-
      context review APPROVE.
      Type: feat · Size: M · Blast: cross-module · Suited: Phase 1 → weaker
      model; Phase 2 (below) → load-bearing, strong model, SEPARATE task.
      Follow-up (Phase 2, not done): `theme` config `auto|dark|light` + an
      OSC-11 terminal-background probe before Ink mounts.
- [x] **Auto-load repo AGENTS.md into the system prompt** (`docs/feat/agents-md-autoload.md`,
      2026-10-17): a fresh session's prompt was only `PROMPT.md` (~90 words); now
      a per-repo `AGENTS.md`, found by walking up from the launch cwd (stopping at
      the `.git` repo root, symlink-loop bounded), is appended after the identity
      under `# Project rules (AGENTS.md)`. Additive (no file → byte-identical) and
      defeatable (`TENTACLE_NO_AGENTS_MD` / `loadAgentsMd:false`). `bun run check`
      645→646 pass; fresh-context review APPROVE-WITH-NITS.
      Type: feat · Size: M · Blast: load-bearing · Suited: strong model + fresh review.
- [ ] **AGENTS.md auto-load — folder-trust gate** (follow-up to the above): v1
      loads a discovered repo's `AGENTS.md` into the prompt UNCONDITIONALLY — a
      prompt-injection surface if tentacle is launched in an untrusted/cloned repo
      (that file becomes instructions for a shell+`fs_edit` agent). The `.git`
      boundary stops *parent*-repo inheritance but not a malicious repo-root file.
      Add a first-run "trust this folder's AGENTS.md?" gate (remembered per path).
      Deferred by the owner when autoload shipped; fine for today's single-user
      trusted-repo use. Type: fix · Size: M · Blast: load-bearing · Suited: strong
      model + mandatory fresh-context review.
- [ ] **Subagents don't receive AGENTS.md** (follow-up to the above): the autoload
      primes only the MAIN session; a spawned subagent (the `task` tool) still
      starts from its agent-definition body (`agent-defs.ts` → `prompt`), not the
      repo rules. Defensible — subagents are handed the executor/reviewer briefs,
      which order reading AGENTS.md — but undocumented, and it partly undercuts the
      weak-model motivation. Decide: inject AGENTS.md into subagent prompts too, or
      document that the briefs are the channel. Type: eval · Size: S · Blast:
      cross-module.
- [ ] **Relabel "Task" → "Agent" + rename tool `task` → `agent_task`**: the
      display label and the model-facing tool name both read as "agent".
      **Promoted eval → feat** (2026-10-17, weak-model gate PASSED — no
      invocation degradation), on branch `feat/subagent-label-rename`.
      **Doc:** `docs/feat/subagent-label-rename.md`. Type: feat · Size: S ·
      Blast: load-bearing (model-facing name). (complementary to the result
      pipeline: skills = *how to do it*, the pipeline = *the guarantee the
      context stays clean*).

## File tools

- [x] **`fs_multi_edit`** — apply several exact-string edits to one file in a
      single call, in order, atomically (Claude-Code style).
- [x] **`fs_read` line ranges** — read a slice via `offset`/`limit` or a
      `path:start:end` suffix instead of the whole file, then edit precisely.

## Result-pipeline transforms

Built on the `ResultTransform[]` pipeline (`packages/agent/src/result-pipeline.ts`),
wired in order: redact → dedup → tabulate → (summarize | spill).

- [x] **`spillLargeOutput`** — spill a too-large tool result to
      `.tentacle/tool-output/<tool>-<id>.txt` and keep only a preview + pointer
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
      **Eval:** `docs/eval/mcp-remote-transport.md` (recommends Streamable HTTP, transport-only first).
- [ ] **Sub-agents**: background / parallel execution (SA.d).
      **Eval:** `docs/eval/parallel-subagents.md` (open — leans background-first, must split; needs a use-case).
- [ ] **Parallel tool calls within a round** (today strictly sequential,
      `agent.ts:283`; pi, Claude Code and opencode all run them in parallel).
      **Eval:** `docs/eval/parallel-tool-calls.md` (open — leans pi shape: parallel
      by default + per-tool `executionMode: "sequential"`, writes/shell
      sequential; measure benefit first; after the proxy-cancel 🔴).
      Type: eval → feat · Size: M · Blast: load-bearing.
- [x] **Native Anthropic Messages API provider** — DONE (2026-10-17). **Doc:**
      `docs/feat/anthropic-api-support.md` (native provider behind the
      `ModelProvider` seam; `model.provider` selector, per-provider default
      `baseURL`, `model.maxTokens`; 3 reviews, last by a different model).
      Follow-up: `docs/eval/anthropic-thinking-echo.md`. Type: feat · Size: M ·
      Blast: cross-module.
- [ ] **F2**: container execution environment (behind the existing
      `ExecutionEnvironment` contract).
- [ ] **Remote control (F3)**: heartbeat/idle-timeout/reconnect, multi-client
      observers, `config.jsonc` `remote` block, operator docs.
- [ ] Add `.tentacle/` to the workspace `.gitignore` guidance (spilled output).
- [ ] Git: the repo still has no commits (commit only on explicit OK).
