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
- [x] 🔵 **Flaky GC test** — DONE, merged 5d1ef0e (2026-11-06; reproduced 4/50; deterministic `openSessionIds` assertion, red without `dropStale()`, 50/50):
      `daemon/test/session-reaper.test.ts` "a connection forgets a session
      another client closed" fails ~1 in 8 full-suite runs. Root cause
      (2026-10-20, heap snapshot): a conservative-GC stack root delays the
      collection its `WeakRef` + 5 × `Bun.gc(true)` assertion demands; the
      production code is correct (the session is unreachable). Plan ready:
      **Eval:** `docs/fix/reaper-gc-flaky-test.md` (getter + deterministic
      assertion).
- [ ] 🔵 **Timing flake, not investigated:** `tui/test/queue.test.tsx` "a task
      typed while running is shown queued…" — a spinner-glyph regex timed out
      under full-suite load once (2026-10-23, task 4b's baseline on an
      unchanged tree, 2048/2/1); run alone `--rerun-each 5` → 15/15 green.
      Likely test-only (frame polling under CPU load); confirm before assuming.
      Found in: `docs/feat/send-now-b.md` (Execution, Baseline).
- [ ] 🟡 **Intermittent timeout, not investigated:** `agent/test/session-store.test.ts`
      "JsonSessionStore durability > drain() resolves only after in-flight and
      queued writes settle" timed out at 5 s once in 12 full runs (2026-10-20).
      Unknown whether test-only or a real `drain()` defect — investigate before
      assuming the former (session persistence path).
- [ ] 🔵 **Test residue:** a `HostedSession` from `cli/test/engine-runtime.test.ts` (was `pod-runtime.test.ts`)
      stays reachable from a root closure through its `SpyFakeCluster` fake after
      the file ends (heap snapshot, 2026-10-20). Test-scoped; tidy when touched.
- [ ] 🔵 **The replay ring is unbounded during a long permission suspension**
      (from `feat/permission-events` Review, 2026-10-20): the ring never evicts
      past the cut (`daemon/src/ring.ts`), and the cut cannot move while a turn
      waits on a permission — which now has no timeout. Updates emitted meanwhile
      (background-job exits, a sub-agent's progress before its ask) accumulate
      for as long as the suspension lasts. Bound them (e.g. coalesce
      `background_exit` past a budget) without unpinning the pending request.
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
      `runMessages` uncaught, same class as Block-1 ①. **Subsumed by**
      `docs/eval/history-validity-invariant.md`. The interactive requester
      resolves `allowed:false` rather than throwing, so low-risk in practice.
- [ ] 🔵 `agent-defs.ts`: `parseFrontmatter` needs `\n---\n` → a CRLF file loses
      its frontmatter silently; `tools: foo` (bare string, no `[]`) falls through
      to `"all"` instead of a single-tool list — a footgun that over-grants.
- [ ] 🔵 `compactedHistory` can leave two consecutive `user` messages (summary +
      next send); OpenAI-compatible servers tolerate it, but note for strict ones.
      **Subsumed by** `docs/eval/history-validity-invariant.md`.

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
- [x] 🟡 **Mid-turn "Queue a task…" (steering) silently no-ops on the worker
      and pod paths (pre-existing gap, surfaced 2026-10-16).** FIXED
      (2026-10-19, `fix/steering-over-rpc`): added a `session/enqueue` request
      (client → daemon → `Session.enqueue`) and streamed the agent's `steer`
      event back over `session/update` (new `steer` update variant), so the
      optimistic ⏳ row reconciles. The TUI now reconciles the ⏳ row on an
      enqueue REJECT (MethodNotFound from an older remote daemon / transport
      drop) instead of masking a send that never happened. Additive protocol
      (version stays 1). Tests in protocol/daemon/client/cli/tui (steering
      order, in-flight concurrency, reject propagation, ⏳ reconciliation —
      each mutation-checked for non-vacuity). **Fix:**
      `docs/fix/steering-over-rpc.md`.
- [ ] 🟢 **Steering follow-ups (from `fix/steering-over-rpc` Review 2).**
      (a) The TUI removes ⏳ rows by COUNT, so a late `NoTurnRunning` reject
      (one round-trip after `turn_end`) can remove a row belonging to the
      NEXT turn's message (`tui/App.tsx`, reconciliation `.catch`). Cosmetic.
      A real fix needs an id per enqueue, which touches the `Agent` core.
      (b) On a reject the typed text is lost; only the notice remains. It
      could be restored into the input line. (c) Pre-existing, out of scope:
      Esc while the first `send` is still opening the session does not cancel
      the turn (`client/remote-session.ts`, the abort listener is attached
      after `openSession`).
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
      SUPERSEDED (2026-10-20, `feat/permission-events`): permissions are stream
      events answered by any client with no timeout; the turn suspends (a cancel
      or close settles it) and a dead socket is never a deny.
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

- [x] 🟡 **TUI: a tab breaks the diff bars and long tool rows** — DONE 2026-10-25, merged `096069a`
      ([`docs/fix/tui-diff-tabs.md`](docs/fix/tui-diff-tabs.md); owner,
      2026-10-25, screenshots) — `renderBar` (`render-lines.ts`) counts a tab
      as 1 cell (and every char by `.length`), Ink passes the `\t` through,
      and the terminal expands it to the next 8-column stop: the full-width
      bar overflows, the terminal wraps it, and a stray stripe of background
      appears under each tabbed line. Read/Bash output rows pass tabs through
      too. Fix: a tab shows as 4 spaces (as in the prompt input), bar width in
      display cells; and diff colours like Claude Code (darker saturated
      background, plain text colour, bright line numbers). Type: fix · Size: S
      · Blast: contained · Suited: Sonnet executes, Opus reviews.

- [ ] 🔵 **TUI: mouse copy turns tabs into 4 spaces** (owner decision in
      the `fix/tui-diff-tabs` Review, 2026-10-25) — the selection copies the
      rendered rows (`App.tsx` `finishSelection` → `extractSelection`), and
      since that fix a tab is rendered as 4 spaces, so code copied from a
      Read/Bash/diff block loses its tabs (Makefile, Go). The model, the
      store and `/save` are unchanged. Owner: keep "copy what you see" for
      now; a faithful copy needs the source text kept next to each rendered
      row. S–M · contained.

- [x] 🟡 **TUI: Ctrl+O expand takes ~0.5 s on a big session** — DONE 2026-10-25, merged `a2d8126`
      ([`docs/fix/tui-expand-latency.md`](docs/fix/tui-expand-latency.md); owner, 2026-10-25) —
      measured on a real 630 KB session (189 tool items, 8048 expanded
      lines, width 150): layout expand 210-245 ms every time, collapse ~40 ms.
      Cause: `wrapLines` (`render-lines.ts`) runs `wrap-ansi` on every line
      (~209 ms) though 97 % already fit the width (`string-width` over all
      lines: 20 ms); and `rowCache` keeps ONE layout per item, so every
      toggle re-lays-out all tool items. Plan (owner OK): fast path for lines
      that fit (proved output-identical), two cache slots per item (collapsed
      + expanded). Expected: first expand ~30-60 ms, later toggles ~0. Starts
      after `fix/tui-diff-tabs` merges. Repro: `.tentacle/tmp/ctrlo-latency/`.
      Type: fix · Size: S · Blast: contained · Suited: Sonnet executes, Opus
      reviews.

- [ ] 🔵 **TUI: one helper for time-budgeted background work** (owner,
      2026-10-25) — in progress: `feat/tui-run-chunked`
      (`docs/feat/tui-run-chunked.md`) has the three callers moved onto
      `runChunked`; left open for the "measure other candidates" follow-up.
      The "slice into ≤ 6 ms chunks, yield with `setTimeout`,
      cancel by a generation token" loop was hand-written in `App.tsx` for the
      resize re-layout (~:535) and the long-history open (~:789,
      `WARM_THRESHOLD`), and `fix/tui-expand-latency` adds a third (idle warm
      of the other Ctrl+O layout). Extract one pure, tested helper (e.g.
      `runChunked(work, { budgetMs, isStale })`) and move the three callers
      onto it. Then measure other candidates before touching them: syntax
      highlighting of a very large Read, `/sessions` with many sessions.
      After `fix/tui-expand-latency` merges. Type: feat (refactor) · Size: S
      · Blast: contained · Suited: Sonnet executes, Opus reviews.

- [ ] **Default `maxIterations` = `-1` (unlimited), agent and sub-agents** (owner, 2026-10-25,
      from the `context-reset` plan questions) — today 16
      (`packages/config/src/defaults.ts:11`); the commented default in the
      generated config, docs and tests follow. Sub-agents' default too
      (50 → `-1`, `:18`; owner "si grazie"). Type: fix · Size: S · Blast: contained ·
      Suited: Sonnet executes, Opus reviews.
- [ ] **The model knows how full its context is (`contextAwareness`)**
      ([`docs/eval/context-awareness.md`](docs/eval/context-awareness.md);
      owner, 2026-10-25, decided) — a line `context: 82k / 128k tokens (64%)`
      once per new percentage point, on the message that crosses it; provider
      usage when available; `"contextAwareness": { "enabled": true,
      "stepPercent": 1 }`. BEFORE `context-reset`. Type: feat · Size: M ·
      Blast: load-bearing · Suited: Opus executes; mandatory fresh-context Review.
      **Status (2026-10-26):** executed on `feat/context-awareness` — task doc
      [`docs/feat/context-awareness.md`](docs/feat/context-awareness.md);
      `DAEMON_RECORD_VERSION` 7; pod window = the laptop's (`--context-window`);
      line hidden from the TUI. Awaiting Review.
- [ ] **Model-initiated context reset (`context_reset({ prompt })`)**
      ([`docs/eval/context-reset.md`](docs/eval/context-reset.md); owner,
      2026-10-25, 9 decisions taken) — the model renews its own context when
      a new part of a plan starts: same session, history replaced by the
      fresh system prompt (re-read: identity, `AGENTS.md`, skills) + the
      model's restart prompt + running jobs list; approval like other tools;
      anti-loop rule + configurable cap (default unlimited); feature on by
      default, configurable. Next: promote and plan. Type: feat · Size: M–L
      (to confirm) · Blast: load-bearing · Suited: strong model, fresh review.

- [ ] 🔵 **TUI: a re-layout at the old width can wipe a fresh resize warm**
      (Review finding 1 of `fix/tui-expand-latency`, 2026-10-25; owner: separate
      task) — if a new item / notice / job exit lands while a resize warm is in
      flight (> 400 ms on a long session), the idle warm restarts at the OLD
      width (`App.tsx` ~:546 and the idle-warm effect ~:636-645) and the
      width-keyed `rowCache` entries just warmed are replaced: the first frame
      after the resize costs ~305 ms instead of ~0.4 ms on a 2.6 MB session.
      Pre-existing in kind on main (a keystroke during a resize). Fix idea:
      while a resize warm is in flight, gate every re-layout on the pending
      width, or key the cache on both widths. S · contained.

- [ ] **Parallel execution — split into 7 tasks** ([`docs/eval/parallel-execution-plan.md`](docs/eval/parallel-execution-plan.md);
      owner answered PE-Q1..Q6 on 2026-10-26: default = read-only parallel, R2,
      shared workspace, one "always" for the session tree, trust MCP
      `readOnlyHint` + override, cap sub-agents at llama.cpp slots). Order: 1
      `feat/fs-path-locks` (S, DONE `bfffdb4`) · 2 `feat/subagent-progress-wire` (M, DONE `ada7918`) · 3
      `feat/model-retry-429` (S, DONE `bb43767`) · 4 `feat/permission-call-attribution` DONE `206adbf` → 5 `feat/round-groups-persistence` DONE `1ee6123` (merged with permission-reply, shared record v8; owner 2026-11-04: phase-1 "Interrupted" accepted; `beforeRun` → `Promise<boolean>`, `true` for never-persisted sessions; task 6 adds the one-at-a-time fallback on a failed write AND the laptop `cutHistory` option (b): "Interrupted" for calls the laptop saw a `tool_start` for, "Not run" for the rest) → 6 → 7 (load-bearing, strictly
      ordered).
- [x] **fix/resumed-call-pending** — done (04f8f14, 2026-11-04): a resumed call allowed without an ask clears its pending entry (awaited) before it runs (task-5 F3). [doc](docs/fix/resumed-call-pending.md)
- [x] **fix: `attach` on a container whose pod binary is older than the laptop's** — **DONE 2026-11-05 as `fix/stale-pod-binary`, merged `119dfc2`** (build id in the version marker; reuse only on an equal build id; 4 rounds + final pass; owner live test OK). fails with a bare `connection closed` (old binary: `unknown option --bridge`, found live 2026-11-04). Must say clearly that the pod binary is stale (and how to fix), or re-copy it. Type: fix · Size: S · Blast: cross-module.
- [x] **feat/run-prompt** — done (b29a56e, 2026-11-04): last word of `run` = first prompt, `--name`, quieter run/attach output, `daemon.log`, mount messages, podman progress in place. [doc](docs/feat/run-prompt.md)
- [x] **fix/attach-any-folder** — done (604533f, 2026-11-04): attach from any folder uses the run's recorded folder; no blank line before `[error]`. [doc](docs/fix/attach-any-folder.md)
- [x] **fix/model-connect-timeout** — done (828ef5b, 2026-11-04): a model endpoint that never answers the TCP connect fails in 15 s, pod runs show the full message. [doc](docs/fix/model-connect-timeout.md)
- [x] **fix/attach-plain-resume** — done (8ba5f1f, 2026-11-04): attach to a plain kept run reopens its session with full history; the kept index records session uid + laptop folder; attach never refuses for a vanished folder. [doc](docs/fix/attach-plain-resume.md)
- [ ] **fix: engine architecture mismatch** (found live 2026-11-04): an amd64 image on arm64 podman runs the x64 binary under qemu → Bun MemoryExhaustion. Pull/create for the native platform, and refuse a mismatch before copying the binary. Type: fix · Size: S–M · Blast: cross-module.
- [ ] **feat/run-oneshot** (owner 2026-11-04, separate from run-prompt): one-shot streaming run in a container, non-TTY stdin (`--prompt -` without `--detach`). Type: feat · Size: M · Blast: cross-module.
- [x] **fix: `attach` to a multi-container pod without `--container`** — done (efe0a1c, 2026-11-04): names the containers (default-container annotation honoured silently); not-found in one line, no log dir.
- [x] **fix/ps-k8s-where** — done (b55c102, 2026-11-04): k8s WHERE `<cluster>/<namespace>`; not-reachable note on stderr.
- [x] **fix/cli-output-streams** — done (bd2e5a3, 2026-11-05): stdout = data only, everything else stderr; D1–D7; one-shot `(tokens …)` line removed. [doc](docs/fix/cli-output-streams.md)
- [x] **fix/tool-output-location** — DONE, merged 3967475 (2026-11-06; orchestrator under the owner's one-night delegation; 3 rounds, 2 fresh Opus reviews; live: `--no-mount` pod with cwd `/` saves to `/root/.cache/tentacle/tool-output/…` and reads it back, laptop single task saves to `~/.cache/tentacle/tool-output/…`, nothing in the project; also folds task-7 NIT 5) (owner 2026-11-05): large tool outputs leave the project (`.tentacle/tool-output/`, `agent.ts:1739`). The daemon picks ONE dir at start: `$XDG_CACHE_HOME` or `~/.cache` → `…/tentacle/tool-output/<project-key>/<session>/<tool>-<id>.txt` if writable, else `os.tmpdir()/tentacle-<uid>/tool-output/…` (containers with an unwritable HOME, e.g. OpenShift random UID). Files 0600. Deleted with the session; files older than `tools.outputRetentionDays` (default 30) removed silently at daemon start; a missing file reads as "no longer available". Old `.tentacle/tool-output/` files are NOT touched (CHANGELOG line). Compare: Claude Code `~/.claude/projects/<p>/<s>/tool-results/`, opencode `~/.local/share/opencode/tool-output/` (7 days), pi `os.tmpdir()`. Type: fix · Size: S–M · Blast: cross-module.
- [x] **feat/tui-light-theme** — DONE, merged 9e1cfc3 (2026-11-06; executed by DeepSeek, 3 Opus review rounds, owner: Q-A `#6b6b6b`, Q-B notice `#2f4ba8`, Q-D 7-bit replies only; 7 slices, red-first + a mutation per behaviour): the TUI decides its palette once, before Ink mounts, from the terminal's background (`OSC 11` + DA1 sentinel, 200 ms cap, then `COLORFGBG`, else dark), and paints a light or dark one from ONE token table (`theme.ts` `tokens`/`buildTheme`/`palette()`/`dimProps()`). Every colour has a light value gated at 4.5:1 (3:1 borders) on white, on Solarized Light and after chalk's real 256 downgrade, with two named exceptions (accent, notice); dark is byte-for-byte unchanged (golden SGR test). A timed-out probe stays raw and arms a late-reply guard on Ink's stdin. Override `tui.theme: auto|dark|light` (file or profile); `connect` reads it from the file alone and warns instead of refusing. Laptop-only — never carried. Doc `docs/feat/tui-light-theme.md`. Type: feat · Size: L · Blast: load-bearing.
- [ ] **tui-light-theme-followups** (LOW, from its review round 3): (1) the timeout hand-over of a cut UTF-8 character (`carry`) has no repo test — a reviewer mutation survived; (2) after a seeded residue, hex keys typed first are dropped; (3) not live-checked: a terminal that never answers the OSC-11 query (mute), and `connect --resume` against a real `serve`. Type: fix · Size: S · Blast: contained.
- [x] **feat/config-carry** — DONE, merged 90e8fef (2026-11-06): laptop settings carried in `session/open.settings` (protocol v16), `subagents.*` keys, one-line `Session settings` / `Container config` notices. Doc `docs/feat/config-carry.md`.
- [x] **fix/detached-autowake** — DONE, merged afe15b5 (2026-11-06; orchestrator under the owner's one-night delegation; live: wake → `woke: WAKE-DONE`, `TENTACLE_AUTO_WAKE=0` → no wake, `ps` `up · idle`, `rm` "its detached run has ended"). Doc `docs/fix/detached-autowake.md`. (owner 2026-11-05): a `run --detach` with NO TUI attached never auto-wakes: the relay (`packages/cli/src/relay.ts`) does not handle `background_exit`, only the TUI starts the continuation turn (`App.tsx:658-664`, `autoWake` read laptop-side `main.ts:834`). Live repro 2026-11-05 (`.tentacle/tmp/autowake-detach/check.sh`, docker + local Qwen): background `sleep 20; echo WAKE-DONE`, after 80 s the record still ends at `started`, `ps` = `detached · idle`. Fix: the relay honours the laptop's `autoWake` when no TUI is attached (continuation turn on a job exit while idle; coalesce; no double wake when a TUI attaches). Also check, same repro: ~15 s later `ps` flipped `detached · idle` → `running · idle` and `rm` asked `-f` ("a session may be attached") with nobody attached. After feat/config-carry. Type: fix · Size: S–M · Blast: cross-module.
- [ ] **fix/detached-autowake-followups** (LOW, from its two reviews, `docs/fix/detached-autowake.md`; R2-1..R2-3 moot: the wake cap was removed by fix/autowake-unbounded, merged e0a5798, owner 2026-11-06 "illimitato"): F6 a refused-wake streak keeps the relay alive (no model calls; accepted); F7 weak bounds `relay.test.ts:2530`, no mutation on R-W4; F8 `handedWakeRef` decision in `App.tsx:1221-1225` and the refusal predicate `relay.ts:403` → pure module. Live oddity: after the woken turn `ps`/log said `running 1 background job(s)` ~10 s with the job already exited. Type: fix · Size: S · Blast: cross-module.
- [x] **feat/serve-autowake** — DONE, merged c234d52 (2026-11-07), doc `docs/feat/serve-autowake.md`: a `serve` daemon wakes its own session when a background job ends, attached clients or not (owner B: on `serve` the daemon is the only waker); laptop `autoWake` switch, a `failed` run never wakes, cut before the wake prompt (no second turn on a mid-wake attach). Live: connect attached → one daemon wake shown live; `TENTACLE_AUTO_WAKE=0` → no wake.
- [ ] **serve-autowake-followups** (LOW, from its reviews + live check): (1) `connect` shows no `n background job(s) ended while you were away` notice on attach (live check 2026-11-07); (2) D6 not pinned with a client attached — no test for Esc/error then another exit while attached (move repro cases A, G into the daemon test); (3) the `connect.test.ts` no-second-waker pin misses a conditional seed (`unflushedExits() > 0 ? { wakePending: true } : {}` stays green; `capturingDial` reports none); (4) docs promise more than `connect` does; (5) stale "nobody attached" wording (`serve.ts:199`, `session-host.ts:182`, daemon test header/describe `:205`, CLI test header, doc title) and `SLOT_LOST_NOTICE` ("another device started a turn") wrong when the daemon's wake took the slot; (6) the tool-bound test is vacuous for the guard; (7) a wake that fails before its flush leaves the exit counted with no notice; (8) Esc pauses daemon wakes until a turn ends normally. Type: fix · Size: S · Blast: cross-module.
- [x] **fix/run-session-never-saved** — MERGED 2026-11-07 (884296f), doc `docs/fix/run-session-never-saved.md`: a long `run` turn was saved on the laptop only when the turn ended, so a pod lost mid-turn (`docker stop`, OOM) lost the whole conversation; now saved after every committed round (`tool_result`), coalesced, the mid-turn copy closed with `cutHistory`; also the `createdAt` re-stamp (`updatedAt == createdAt`). Type: fix · Size: M · Blast: load-bearing · Suited: strong model + fresh-context Review.
- [ ] **run-session-never-saved-stuck-readback** (LOW, owner Q4 2026-11-07, `docs/fix/run-session-never-saved.md` Context "Side finding"): a read-back lost on a link that keeps carrying the pod's `model/stream` traffic delays every later save until liveness (15 s of inbound quiet) replaces the link — saves are delayed, not lost. Separate fix; needs a lost frame on an otherwise healthy stream. Type: fix · Size: S–M · Blast: load-bearing (persistence/liveness).
- [ ] **tui-busy-after-docker-stop** (LOW, owner R3 2026-11-07, `docs/fix/run-session-never-saved.md` Review "Optional repro"): on 65a0f07 the in-process repro (`repro-h6.ts kill`) shows the turn never ends (`busy=true` > 20 s) after the pod link is gone; A/B with the fix disabled is the same, so not caused by that diff; may be a repro artifact. **Confirm on clean `main` first** (one run), then a separate fix/eval. A TUI stuck "busy" after `docker stop` would be user-visible.
- [ ] **feat/session-log** (Type: feat · Size: L · Blast: load-bearing · Suited: Opus exec + fresh Opus review) — decided in `docs/eval/session-persistence-format.md` ("Owner decisions"): the laptop↔daemon read-back becomes a typed event log (`session/log {after}`, `type` on every entry), with the review's F1–F5 as binding requirements. Replaces the full `snapshot` read-back per round (500k tokens: 1.96 MB → 2.6 KB per save). May subsume `run-session-never-saved-stuck-readback`.
- [ ] **feat/session-log-laptop-store** (M · load-bearing) — after `feat/session-log`: the laptop session file becomes the log (`<uid>.jsonl`), lazy conversion of JSON records, optional keep of pre-compaction / pre-reset history (config, default false), §7 persistence wording.
- [ ] **feat/session-log-serve-store** (M–L · load-bearing) — after the laptop store: the `serve` daemon store on the same log; Linux fsync / `O_APPEND` measurements first.
- [ ] **pod-turn-auto-continue** (owner 2026-11-07, live test of `feat/session-log`) — when a pod daemon dies mid-turn and the laptop recreates the session (reseed), the interrupted turn is NOT resumed: the agent waits for the user. Owner wants an automatic "continue" after the recreate — OPT-IN setting, default OFF, never under manual tool approval unless explicitly enabled (owner 2026-11-07), like the `serve` daemon does for suspended turns (`docs/feat/suspended-turn-resume.md`). Separate task, after `feat/session-log`; size/blast to be planned. Related: the silent turn end after a daemon kill (investigation `.tentacle/tmp/silent-turn-end/findings.md`) — the TUI must at least SAY the turn was interrupted.
- [ ] **fix/silent-turn-end** (S–M · cross-module · no protocol/format; owner 2026-11-07) — NOT a regression of `feat/session-log` (same on main): when a pod daemon dies mid-turn the client fails the turn and the TUI adds a ⚠ row, but the recreate's `history` activity (`client/src/remote-session.ts:1123`, applied in `drainHeld`, `tui/src/App.tsx:1427`) REPLACES the transcript and wipes that display-only row → the TUI goes silently idle. Fix in a pure module (keep/re-add the notice after the restored transcript). Owner-approved text: `⚠ Daemon lost: turn interrupted. Type to continue.` (no `RpcError:` prefix). Findings + in-process repro: `.tentacle/tmp/silent-turn-end/findings.md` (copy into the task doc).
- [ ] **recreate-interrupted-marker** (LOW, owner 2026-11-07) — verify first: after a pod recreate mid-TOOL, is the cut call closed for the MODEL with an explanation (like `serve`'s "interrupted: the daemon restarted during this turn", `daemon/src/persisted-session.ts:516-556`)? Only matters when a tool was killed mid-execution (half-done side effects); if missing, a small load-bearing fix.
- [x] **fix/engine-runtime-stderr-flake** — DONE, merged 514219f (reproduced 1/50; the backoff redial could come back `up` before dispose; the test now makes the redial fail for good and waits for `stopped`; 1700/1700). (2026-11-06): `packages/cli/test/engine-runtime.test.ts` "startPodRuntime > daemon stderr on exit > attach: a dropped link: one line with the log path" failed once in the full `bun test packages` (6.5 ms) on the run-rm-flag build, then 3/3 green alone — a timing flake under load, like the reaper GC one. Find the race (wait on the event, not a tick). Type: fix · Size: S · Blast: contained.
- [ ] **feat/session-settings-apply-followups** (LOW, round-2 review): R2-1 no test that re-served snapshot pages do not count as attach progress (mutation `attachMark = 0` stays green; code right by reading); R2-2 a hostile pod can stretch an attach to ~83 h with fabricated pages (finite, `SNAPSHOT_MAX_PAGES`); a failed sync after a session switch is told nowhere. Owner note: likely drop the W rule (container wins) for run/attach — then `// (container)` goes too; decide with project-config eval Q5–Q11. Type: fix · Size: S · Blast: cross-module.
- [x] **feat/write-tmpdir** — DONE, merged d46c029 (2026-11-07), doc `docs/feat/write-tmpdir.md`: `fs_write`/`fs_edit`/`fs_multi_edit` may write to `$TMPDIR` and `/tmp` by default (`tools.writableDirs`, env `TENTACLE_WRITABLE_DIRS`, a list replaces the default, `[]` = project only; not carried to a pod). Also hardened in the project: dangling/looping symlinks refused, atomic temp+rename writes (0600 temp, mode kept, hard links broken like an editor's save), `EACCES` parity with main, in-place fallback (no symlink, no hard link) for an existing file in a non-writable dir. Owner: no directory owner/mode rule. Live: /tmp asks+writes, symlink out refused, 0775 dir ok, hard link written, env empty → /tmp refused, container /tmp writable, `--rm` removed.
- [ ] **write-tmpdir-followups** (LOW, from its review round 4 + accepted residuals): (1) `README.md:321` and `CHANGELOG.md` say an existing outside file is "never written in place" — too absolute under the shared-root race (the rename over a same-named outside file was not excluded, only never seen in 135k writes); (2) `host-execution.ts:454` would wrongly say "temp file left" on a Linux read-only mount (unverifiable on macOS); (3) accepted residual: on hosts shared with other users, a user controlling a dir on the path in `/tmp` can race a swap and leave hidden `.tt-*` files with our content elsewhere; (4) the dropped-entry notice fires once per `buildAgent` (once per `serve` session); (5) below ~46 columns the permission key-hint footer wraps (pre-existing). Type: fix · Size: S · Blast: contained.
- [x] **fix/attach-unflushed-exits** — DONE, merged f9b9cf4 (2026-11-06), doc `docs/fix/attach-unflushed-exits.md`: `session/open` carries `unflushedExits`; an attach shows `n background job(s) ended while you were away` and, under `autoWake`, starts the wake turn (one turn for concurrent attaches; rendered live — the wake waits for the session watch). Owner: no lost-slot retry.
- [ ] **attach-unflushed-exits-followups** (LOW, from its reviews): (1) multi-session seed — a session opened later in the same TUI (`/sessions` switch) is not seeded (owner 2026-11-06: follow-up); (2) T-TUI-6b does not exercise the round-3 deferral guard; (3) late-`open` ordering vs the deferred wake untested (`remote-session.ts:1118`); (4) the deferred `setTimeout` can fire `runRef` after an unmount in the same tick (pre-existing `wakeIfPending` pattern); (5) residual race: a count-seeded TUI B whose continuation lands after A's wake turn ended starts an empty turn (needs a daemon-side "nothing unflushed" refusal). Type: fix · Size: S · Blast: contained.
- [x] **fix/detached-model-error-reason** — DONE, merged b191ce4 (2026-11-06); (found live 2026-11-05, diagnosed in feat/config-carry round 2): a `run --detach` whose model answers an HTTP error (a 401 from a config with no API key) ends `state: failed internal error` in `relay.log`, with no reason. The redaction toward the pod is right (§7), but the laptop knows the cause and does not say it where the user looks. Path: `remote-client.ts:2063` (`connectionLost`) rethrows, `transport/src/peer.ts:376` answers the pod an opaque text, `daemon/src/hosted-session.ts:254` reports it; the real message goes only to the run's `daemon.log` (`engine-runtime.ts:1044`, by reading). Fix: answer with a text built from the HTTP status only (`the model endpoint answered 401`), never the provider's message, or log the local error to `relay.log`. Test: a provider throwing a 401 → the relay's `failed` detail names it, no provider text reaches the pod. Type: fix · Size: S · Blast: cross-module.
- [x] **feat/session-settings-apply** — DONE, merged 4953cfd (2026-11-06; personal→condo Opus, 3 rounds + item fixes, 2 fresh Opus reviews; commands `/settings` (nested JSON, `// this terminal: …`, `// (container)`) and `/settings sync`; live notice to other terminals; bounded plain-attach open re-armed on progress; live via tmux PASS). Doc `docs/feat/session-settings-apply.md`. (owner 2026-11-05, after feat/config-carry): a live session keeps the settings it was created with; an attach only reports the difference (`Session settings: {…} (/clear to reset)`). Add a way to apply the laptop's settings to the live session, between turns: a TUI command (`/settings apply`, recommended over a flag or an automatic apply, since other attached terminals share the session), an additive protocol method (`session/update_settings`), W keys the container sets still win, `loadAgentsMd` / `loadSkills` recompose the context. Also from the config-carry round-2 review: bound the plain attach's `session/open` (no `requestTimeoutMs` today, `main.ts` plain path, same on the join path `attach-run.ts:355`). Type: feat · Size: M · Blast: load-bearing.
- [x] **feat/tui-notice-palette** — DONE, merged 64e3e57 (2026-11-06); (owner 2026-11-05, after feat/config-carry): every TUI notice (`noticeLines`, `packages/tui/src/render-lines.ts:587`, today `⏺` + text all `theme.subtle`) gets ONE notice colour — soft blue, dark `#8caaee` / light `#3b5bdb` (chosen over lilac and "bullet only") — as a `theme.ts` token (the light-theme task reads it), and its hint in grey: a notice gains a separate `hint` field (e.g. `(/clear to reset)`, `(Shift+Tab to turn it off)`), never parsed out of the text. Senders of hinted notices updated (settings notices in `packages/cli/src/carried-settings.ts`, auto-accept). `relay.log` stays plain text. Type: feat · Size: S · Blast: contained · Suited: Sonnet.
- [ ] **fix/tool-output-location-followups** (LOW, round-2 review, `docs/fix/tool-output-location.md`): (3) on a case-insensitive FS (default APFS) session ids `AB`/`ab` share one spill dir; (4) a swept spill name can be reused by a server that reuses call ids (old banner then reads new content); (5) `HOME=/w`, `cwd=/w/sub` still writes into `/w/.cache` (Q1 only checks root-inside-cwd); (6) tests using the real `toolOutputStore()` (`serve-persistence.test.ts:419,439`) reach the real `$TMPDIR/tentacle-<uid>/tool-output`, outside the test env guard; two `agent-spill-sink` tests leave `project` in tmp. Type: fix · Size: S · Blast: contained.
- [ ] **feat/parallel-agents follow-ups** (task 7 review, 2026-11-06) — items (1) and (3) DONE in fix/parallel-agents-followups, merged 40d86c0 (cells-width rows; `[agents]` prefix, live one-shot shows `[agents] sub-agents capped at 1 at once…`); only the live `-np 2` checklist remains: (1) `tui/src/permission-ui.ts:81` (and `PermissionPrompt.tsx:11-13` `truncate`) cut by UTF-16 length, not cells — a CJK / wide label makes the dialog one row taller than `permissionPromptRows` says; one width-aware helper (string-width, like `cells.ts`). (3) `cli/src/wiring.ts:294` logs `sub-agents capped at N at once…` through `options.log`, which `main.ts` prefixes with `[hook]`: give it its own prefix. (5) DONE in fix/tool-output-location (exclusive-create spills). **Live, not yet run:** fan-out with a server at `-np 2`+ (N=1 vs N=3 timing, `subagents.execution: parallel` vs `sequential`, the permission prompt naming the child, Esc on one child / the parent). Type: fix · Size: S · Blast: contained.
- [ ] **feat/pod-laptop-only-notice** (owner 2026-11-05, config-carry Q5): when a session runs in a pod/container, the laptop says once which of ITS setup does not apply there — `hooks`, `mcpServers`, `PROMPT.md`, `agents/` — like the existing packages line (`main.ts:641-646`; `docs/container-config-sources.md` §3.3, eval project-config rule 10). Right after feat/config-carry. Then an owner discussion: what more can be carried into the pod/container (eval project-config Q9 MCP, skills, sub-agent defs). Type: feat · Size: S · Blast: contained.
- [x] **fix/cli-tests-terminal-clean** — DONE, merged 44c43e4 (2026-11-06; under `script` 1 unidentified fail in 1 of 4 runs — watch); (review of fix/cli-main-terminal-seam, F1, 2026-11-05): outside `main.test.ts`, `packages/cli` is still not terminal-clean — under the silent-TTY preload (`.tentacle/tmp/flaky-tests/tty-silent-preload.ts`) `output-streams.test.ts:149` mounts the real TUI and times out (run exits 130, no summary) and 7 `engine-runtime.test.ts` tests fail (`:653` registers 2 exit handlers instead of 1; `terminal.ts:49` suspected, unconfirmed). A developer running `bun test packages/cli` in a terminal loses the run. Same seam pattern as fix/cli-main-terminal-seam. Type: fix · Size: S · Blast: contained.
- [x] **fix/resume-cancel-silent** — DONE, merged d0afc85 (2026-11-06); (owner 2026-11-05): Esc in the `--resume` session picker prints `[resume] cancelled`; the owner wants a silent exit (option A: no line at all). Both paths: `packages/cli/src/session-resume.ts:103` (local) and `packages/cli/src/connect.ts:235` (`connect --resume`); tests `session-resume.test.ts`, `tui-sessions.test.ts`, `connect.test.ts` (the last is edited by feat/config-carry → start after it merges). Keep the exit code as today. Type: fix · Size: S · Blast: contained · Suited: Sonnet.
- [x] **fix/run-rm-flag** — DONE, merged 0732481 (2026-11-06; personal Opus, fresh Opus review PASS 1 LOW fixed; live docker: `--keep` unknown, `run -d --rm` removed after the idle grace, `run -d` kept `up · idle`, old binary reads a v2 record as `unknown owner`). Doc `docs/fix/run-rm-flag.md`. (owner 2026-11-04): replace `run --keep[=true|false]` with `--rm` (docker/podman/kubectl convention: default keeps, `--rm` removes when the run ends; `--detach --rm` = removed when the run ends). Config `keep: false` → `rm: true`; `--rm=false` only overrides the config. No `--remove` alias, no `--keep` compat (pre-public; CHANGELOG line). Update help, README, the `still running · removed when the run ends` line, docs/attach-detach-behaviour.md. After fix/cli-output-streams (same files). Also add `-d` as the short flag of `--detach` (owner 2026-11-04). Type: fix · Size: S–M · Blast: cross-module.
- [x] **feat/parallel-tools** (parallel-execution task 6) — done (a427121, 2026-11-05): `tools.execution` read-only default, maxParallel 8, MCP `readOnlyTools`, queued/running signal, exact cut labels, protocol v15. [doc](docs/feat/parallel-tools.md)
- [x] **fix/cli-main-terminal-seam** — DONE, merged 0a7496b (2026-11-05); (investigated 2026-11-05, report `.tentacle/tmp/flaky-tests/report.md` — copy it into the task doc's Context): NO timing flake — 0 fails in 39 full runs. The "2 flaky" fails are `main.test.ts` D4 + R2-1, which depend on stdin (an open, silent, non-TTY pipe), and the 7 TTY-dependent `main.test.ts` failures (entry below) have the same root cause, all reproduced without `script` via `--preload` stubs. One fix: inject the terminal/stdin state through a test seam with unchanged production defaults. Closes both entries. Type: fix · Size: S · Blast: contained.
- [x] **feat/tui-target-badge** — **DONE 2026-11-05, merged `7ee6dc2`** (6 rounds: exec Sonnet ×5 + 1 fresh; reviews Opus; owner live test OK; final format `kubernetes:<pod>/<container>` · `docker:` · `podman:`, grey prefix, `k8s:` when narrow, auto-accept on `#fec20a`). (owner 2026-11-04): in a container/pod the status bar shows, left, an accent-coloured (not dim) badge with engine + name — `docker tentacle-ba89d072 · ~/trash · ↑…`, `podman …`, `pod <name>`, and `pod <name>/<container>` when the pod has more than one container (so the annotation-picked container is visible). Local: nothing, bar unchanged. Never truncated: the path shrinks first. The name comes from the laptop (never pod-supplied text). Plus (owner 2026-11-04): the model name MOVES from the status bar to the input field's top border, right-aligned (`──── rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 ─`, like Claude Code's session title); too long → cut on the LEFT with `…`. Plus (owner 2026-11-05): ctx is ALWAYS shown with its max; before this TUI measured a turn (fresh session, attach) it shows the exact count where the provider can count without generating (Anthropic `count_tokens`, llama.cpp `/tokenize` with the chat template), else the existing estimate (`estimateUsed`, heuristic chars/4 — measured 0.02 ms on ~500k tokens) marked `~`; exact after the first turn. ↑↓ hidden until measured. Daemon-side, once at open. Type: feat · Size: M · Blast: cross-module.
- [x] **fix: `main.test.ts` depends on the real terminal** — DONE via fix/cli-main-terminal-seam (0a7496b); (found 2026-11-04): run under a TTY (`script -q /dev/null bun test packages/cli/test/main.test.ts`) 7 tests fail on main (help with no prompt times out, skill/agent-def diagnostics, R13 attach, slice-E attach, two mount tests hit a real `Continue? [y/N]`). CI/agents run without a TTY so it is hidden. Tests must inject the TTY state, never read the process's. Type: fix · Size: S · Blast: contained.
- [ ] **Parallel tool calls** ([`docs/eval/parallel-tools.md`](docs/eval/parallel-tools.md);
      owner, 2026-10-25) — run a round's calls in parallel where safe; which
      tools are parallel-safe to evaluate; setting `sequential` | `parallel`,
      default to recommend (owner's first idea: sequential). AFTER task 7
      and `context-reset`. Type: eval → feat · Blast: load-bearing.
- [x] **Parallel sub-agents** — DONE as `feat/parallel-agents`, merged 745cf13 (2026-11-06; doc `docs/feat/parallel-agents.md`, follow-ups above) ([`docs/eval/parallel-agents.md`](docs/eval/parallel-agents.md);
      owner, 2026-10-25) — run several `agent_task` calls in parallel;
      setting `sequential` | `parallel`, default to recommend (owner's first
      idea: parallel). Separate task from parallel tools, evaluated
      together. AFTER task 7 and `context-reset`. Type: eval → feat · Blast:
      load-bearing.

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

- [x] 🔴 **Pod `--model-proxy`: cancel didn't stop the model, and the requested
      tool could still run.** FIXED (merged to main 2026-10-19): the agent loop
      now re-checks `aborted` at every boundary (after the stream completes,
      before each tool call, after the last tool on the cap path, and in
      `runTool` after a permission approval) — no tool starts after a cancel,
      provider- and runtime-independent. Three fresh-context reviews, all
      findings resolved; gate green (728 pass).
      `docs/fix/proxy-model-cancel.md`. Type: fix · Size: S · Blast:
      load-bearing. **Model half fixed** by `fix/pod-model-streaming`
      (2026-10-18). Batch-fallback *wait* follow-up split out below.
- [ ] 🟡 **Pod `--model-proxy` batch fallback waits for the laptop's generation
      to finish after a cancel.** Split off the item above (FIXED, merged to
      main 2026-10-19): the loop fix stops the *actions*, but a
      mixed-version (old-laptop, batch-only) pod still waits for the laptop's
      generation to complete. Low priority — race `send` against the signal in
      `packages/daemon/src/proxy-model.ts:~183`.
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
- [x] 🟡 **`session/compact` races a turn on the daemon** (both directions: compact
      mid-turn → orphan `tool` msg; prompt mid-compact → turn silently lost).
      CONFIRMED. **Fix (DONE 2026-10-20, `fix/daemon-compact-turn-guard`):**
      `docs/fix/daemon-compact-turn-guard.md`. Type: fix · Size: S ·
      Blast: load-bearing.
- [x] 🟡 **No daemon session lifecycle**: background jobs orphaned on `/clear` /
      disconnect / exit; duplicate `sessionId` clobbers; `shell_kill` misses
      grandchildren. CONFIRMED. **Eval:** `docs/eval/daemon-session-lifecycle.md`.
      DONE through other tasks (audit 2026-10-20): `fix/background-process-groups`
      (process groups, dispose on close, exit net) + `feat/session-registry` and
      `feat/session-ttl-limits` (daemon-owned sessions: a live id re-attaches,
      jobs disposed on close). Type: eval · Size: M · Blast: load-bearing.
- [ ] 🟡 **No history-validity invariant** (dangling tool_calls / invalid-JSON args
      persisted and re-sent; resume repairs nothing). CONFIRMED (mostly).
      Subsumes the Block-3 requester-throw + consecutive-user items.
      **Eval:** `docs/eval/history-validity-invariant.md`. Type: eval · Size: M ·
      Blast: load-bearing.
- [x] 🟡 **Session store not crash-safe** (in-place write truncates; failed `void
      save` crashes the TUI; corrupt files vanish from `--resume`; no schema
      check). FIXED (2026-10-20, `fix/session-store-durability`):
      `docs/fix/session-store-durability.md` — atomic temp+fsync+rename, per-uid
      latest-wins queue, validated loud `load`/`list`, save failures → TUI notice.
      Type: fix · Size: M · Blast: load-bearing.
- [ ] **Detach `fix/detach-live`** ([task doc](docs/fix/detach-live.md)): the live
      test's defects in S1–S3. `/quit` closes the session for every TUI on it (y/N
      with others), FAIL 39, the attach notice, the launcher line; auto-accept
      inherited on attach, Shift+Tab per session and shared. EXECUTED 2026-11-01,
      awaiting the fresh-context Review and the owner's live re-run.
      Type: fix · Size: L · Blast: load-bearing · Suited: Opus, fresh review.
      Candidates left by it (owner's list, not planned): footer `↑0 ↓0 · ctx 0%`
      after attach; the `thinking…` timer starts at attach; Enter on a permission
      prompt opening while typing `/quit` approves it; `MultiEdit` ask shows `—`;
      `[resume] … — (empty)` left after exit; `attach` without `--profile` shows the
      default model; `dispose()`'s same late read (one `seal`); a window close or
      crash during this TUI's model call fails the other's turn (needs re-routing).
- [x] ✅ **Detach S2b + S4 `feat/detached-relay-lifecycle`**
      ([task doc](docs/feat/detached-relay-lifecycle.md); split out of S2, owner
      Q1, 2026-10-30; S4 folded in, owner 2026-10-31) — **DONE, merged `4f0fc2f` 2026-10-31**
      (fresh Opus Review + 2 DeepSeek fix rounds). DR-5 `--keep=false` with `--detach`, DR-9
      keep-awake, the two `Detach S2` items below, `ps` STATUS through `statusOf`,
      `rm` stops the owner. S2 live-test items 3, 8, 17 moved to its checklist,
      run by hand after S3 merges; before S3, same release.
      Type: feat · Size: L · Blast: load-bearing · Suited: Opus, fresh review.
- [x] ✅ **Detach S2: report the resident's REAL version** (DONE in
      `4f0fc2f`, Phase A; Review of
      `feat/detached-runs` S1 fix round 4, F2 + F3, 2026-10-30; owner: defer to
      S2) — `--resident-status` does not say which version the running
      resident is. So (F2, `engine-runtime.ts:639`) the "stray resident"
      warning fires only on `inject` (once): a later `attach` that takes
      `reuse`, or the `replace` path, joins a resident of another BUILD inside
      the same protocol version silently (`initialize` still refuses a
      protocol skew); and (F3, `pod-resident.ts:733`) a refusal names the
      ASKING binary's version, not the resident's, so it can suggest the wrong
      version. Fail-closed today (nothing stopped or installed). Fix: add the
      resident's version to `--resident-status` and use it in both places.
      Type: fix · Size: S · Blast: load-bearing (detach) · Suited: Opus, fresh review.
- [x] ✅ **Detach S2: do not stop an idle resident before an install that cannot land**
      (DONE in `4f0fc2f`, Phase A; Review of
      `feat/detached-runs` S1 fix round 5, F3, 2026-10-30; owner: defer
      to S2) — `engine-runtime.ts` stops the idle resident (`:580`) BEFORE the
      install (`:594`). With an unwritable install path and a different version
      (non-root image, no `--bin-dir`) every `attach` stops the idle resident,
      fails the install and goes on with the old binary: it never converges, and
      an idle resident may hold a finished session. Loud today (the warning names
      `--bin-dir`). Fix: check the install path is writable (or install to a temp
      name) before stopping. Type: fix · Size: S · Blast: load-bearing (detach) ·
      Suited: Opus, fresh review.
- [ ] 🔵 **TUI: close a turn's still-running tool calls when the turn fails**
      (Review of `feat/tui-tool-blink`, 2026-10-30; owner: separate task) — after
      a failed turn a tool call stays `running` in the session state (seen as a
      bullet blinking forever, `App.tsx` ~:701); `feat/tui-tool-blink` only gates
      the blink on the turn running. Close them in the reducer (as cancelled /
      failed) when the turn ends without their result. Type: fix · Size: S ·
      Blast: cross-module · Suited: Sonnet executes, Opus reviews.
- [ ] 🔵 **k8s: recover the real exit code of a failed exec** (Review of
      `feat/detached-runs` S1 fix round 2, finding 3, 2026-10-30; owner: not in
      S1) — `packages/k8s` `exec-run.ts:99-102` maps every `Failure` status to
      exit 1 but keeps `details.causes[0].message`, which on `NonZeroExitCode`
      is likely the numeric code (unverified: no fake pins it, no cluster
      here). If so, a killed `residentGuard` probe (137) on k8s could refuse
      like docker instead of landing on `none`. Verify on kind first. Type: fix
      · Size: S · Blast: contained · Suited: Sonnet executes, Opus reviews.
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
- [x] 🟡 **No retry on a transient model-connection drop** (`ECONNRESET` kills
      the turn and the sub-agent; only manual `/retry`), and the error log says
      `(no stack)` with no phase. Recommends retry pre-first-byte only + phase
      diagnostics. **Feat (promoted 2026-10-21, `feat/model-connection-resilience`):**
      `docs/feat/model-connection-resilience.md` — DONE — merged (`399ea0b`); reviewed (APPROVE-WITH-NITS, nits fixed).
      Type: feat · Size: M · Blast: load-bearing.
- [x] 🟡 **`shell_kill` leaves grandchildren running** (only `sh` gets the signal;
      a compound command's child is re-parented to PID 1). FIXED (2026-10-19,
      `fix/background-process-groups`): every shell runs in its own process
      group (group TERM → KILL), `dispose()` on connection close, and a
      main-thread exit net (incl. the worker path, `cmd &` children, SIGHUP/
      SIGTERM; `nohup` preserved). See `docs/fix/background-process-groups.md`.
- [ ] 🟢 **Graceful shutdown for background jobs** (follow-up of
      `fix/background-process-groups`). On the worker path, and in practice on
      stdio/ws `serve`, tentacle's exit kills job groups with SIGKILL only — no
      TERM grace (dev servers may leave sockets/temp files). Fix: a `shutdown`
      handshake (worker runs `Connection.close()` → `dispose()`, acks, bounded
      by a timeout) and an awaited grace before `process.exit`; the exit net
      stays the fallback. Likely folded into the v2 `session-registry` child.
      See Notes/debt in `docs/fix/background-process-groups.md`.
      Type: feat · Size: S–M · Blast: load-bearing.
- [ ] 🟡 **OpenAI provider treats an in-band SSE `{"error":…}` chunk as an empty
      stream** (HTTP 200, no throw), so callers see a silent empty response (e.g.
      `/compact` wiping history). See `docs/fix/compact-empty-summary-wipe.md`
      (the wipe is guarded there; this provider defect — which also affects
      normal turns — is the separate follow-up).
- [x] 🟡 **A failed session save crashes the TUI** (`void store.save` rejects →
      unhandled rejection → exit 1 with a raw stack). See
      `docs/fix/session-store-durability.md` (fixed there: `SessionSaver`).
- [x] 🟡 **`--resume` (no uid) resumes another project's session**: FIXED
      2026-10-20, `fix/session-store-per-project`: sessions now live in
      `~/.config/tentacle/sessions/<projectKey(cwd)>/<uid>.json` (old flat files
      ignored, no migration — owner, pre-v0.1.0; another project's uid is refused).
      `docs/fix/session-store-per-project.md` · M · load-bearing (fresh Review waived by the owner).
- [x] **`--resume` picker**: DONE 2026-10-20, `feat/resume-picker`.
      `--resume` (no uid, ≥2 sessions, on a terminal) opens a pre-mount Ink
      picker (↑↓/jk, Enter, Esc/Ctrl+C → exit 0); `--continue` resumes the
      newest; no TTY → newest, said explicitly. Covers tui/run/attach through
      `openTuiSessions`. `docs/feat/resume-picker.md` · M · cross-module (fresh
      Review skipped by the owner). Follow-up: in-TUI `/resume`.

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

### `/mcp` follow-ups (from `docs/feat/mcp-status.md` Review, 2026-10-21)

- [ ] 🔵 **A command notice that lands mid-reply splits the reply.** The display
      no longer merges them, and `/copy` skips notices. But `/save` still emits
      the two halves as separate `## Assistant` blocks, and a notice inside an
      open code fence leaves the fence broken in the live view. Options: hold an
      async notice until the reply's text ends, or insert it before the item
      that is still streaming. Display/export only, never persisted.
      Type: fix · Size: S · Blast: contained.
- [x] 🔵 **A late `/mcp` answer appears after `/clear`.** FIXED by
      `feat/mcp-tools-panel` (2026-10-21): `/mcp` is a panel now; a probe that
      answers after its panel closed is dropped (generation token).
- [x] 🟡 **`/mcp` — interactive panel listing each server's tools.**
      `docs/feat/mcp-tools-panel.md`. Type: feat · Size: L · Blast:
      load-bearing (wire v7→v8 + a new in-session modal) · Suited: strong
      model; fresh-context Review waived by the owner (budget). Merged 2a7a913.
- [x] 🟡 **`/skills` — panel listing every skill the daemon found.** Who may
      invoke each one (you / model), where it lives, and the discovery problems
      (now visible on `run`/`attach` too). New wire method `skills/list`
      (additive, v8 kept); the `/mcp` panel logic generalised into
      `tree-panel.ts`. DONE — merged (`c2027c8`): `docs/feat/skills-panel.md`. Type: feat · Size: L ·
      Blast: load-bearing · Suited: strong model; fresh-context Review waived
      by the owner (budget).
- [ ] 🔵 **`/mcp` polish.**
      - ~~No "probing…" placeholder during the ≤2 s probe.~~ Done by
        `feat/mcp-tools-panel`.
      - The tool list includes tools skipped for a name clash at register time.
      - The `methods.ts:1-6` header says the peer validates `result` before
        replying. Only the receiver validates (`peer.ts:436-444`).
      - ~~With the panel open, a paste or a lone typed `[` still lands in the
        hidden input.~~ Done by `feat/skills-panel` (bracketed paste, its
        timeout flush, a held `[`, and a late Ctrl+V clipboard read).
      Type: feat · Size: S · Blast: contained.

### Block 11 — new capabilities under evaluation (2026-10-19)

- [ ] **Tentacle is not usable from ACP editors (Zed)**: our wire is
      ACP-shaped but not ACP-compatible, and there is no `tentacle acp`. Proposal:
      an adapter frontend over `createLocalRuntime` (no wire change).
      **Eval:** `docs/eval/acp-adapter.md`. Type: eval → feat · Size: M (v1) ·
      Blast: load-bearing.
- [ ] **Sub-agent in an ephemeral Kubernetes pod** (opt-in, e.g. `runOn: "pod"`
      on `agent_task`). Open decisions D1–D8; D1 (what code the pod works on) is
      unanswered. **Eval:** `docs/eval/subagent-in-pod.md`. Type: eval → feat ·
      Size: M–L · Blast: load-bearing.

- [ ] **Sessions die with their connection; no re-attach** (blocker for the
      mobile app). Protocol-v2 redesign: daemon-owned sessions, `session/open`,
      seq'd byte-bounded stream + consistent-cut snapshot, compaction barrier,
      idempotent commands, permissions as events (no timeout: the turn suspends
      until a human answers), 24 h idle TTL, multi-attach, thin-client
      profile, JSON Schema export. CONFIRMED (repro); fresh-context review
      F1–F8 integrated. **Parent eval:** `docs/eval/session-reattach.md`.
      Children drafted (Implementation per child) and owner decisions A–G, D1–D10
      recorded in the parent (2026-10-19).
      Type: eval (parent) · Size: L → split · Blast: load-bearing. Children, in order:
      1. **Fix (DONE 2026-10-19, `fix/background-process-groups`):** `docs/fix/background-process-groups.md` · S–M · load-bearing
      2. **Feat (DONE 2026-10-19, `feat/protocol-schema-export`):** `docs/feat/protocol-schema-export.md` · S–M · cross-module
      2b. **Fix (DONE 2026-10-20, `fix/daemon-compact-turn-guard`):** `docs/fix/daemon-compact-turn-guard.md` (before 3c)
      (Steps 3a–3c are the three parts of `docs/eval/session-event-stream.md`,
      now closed: all three merged.)
      3a. **Feat (DONE 2026-10-20, `feat/session-wire-classes`):** `docs/feat/session-wire-classes.md` · M · load-bearing
      3b. **Feat (DONE 2026-10-20, `feat/session-turn-events`):** `docs/feat/session-turn-events.md` · M · load-bearing
      3c. **Feat (DONE 2026-10-20, `feat/session-history-cut`):** `docs/feat/session-history-cut.md` · M · load-bearing
      4. **Feat (DONE 2026-10-20, `feat/session-registry`):** `docs/feat/session-registry.md` · L · load-bearing
      5. **Feat (DONE 2026-10-20, `feat/session-ttl-limits`):** `docs/feat/session-ttl-limits.md` · M · load-bearing
      5b. **Fix (DONE 2026-10-20, `fix/session-store-durability`):** `docs/fix/session-store-durability.md` · M · load-bearing (before 6)
      6. **Feat (DONE 2026-10-20, `feat/daemon-side-persistence`):** `docs/feat/daemon-side-persistence.md` (Part A, `serve` only) · M · load-bearing
      7a. **Feat (DONE 2026-10-20, `feat/permission-events`):** `docs/feat/permission-events.md` · L · load-bearing
      7b. **Feat (DONE 2026-10-20, `feat/suspended-turn-resume`):** `docs/feat/suspended-turn-resume.md` · M · load-bearing
      — **Fix (DONE 2026-10-20, `fix/cancel-hung-disk`):** `docs/fix/cancel-hung-disk.md` — a
        hung disk no longer traps `cancel` of a turn waiting on a permission (the
        gate's clear-before-run wait now ends on the turn's abort) · S · load-bearing
        (fresh-context Review waived by the owner)
      8a. **Feat (DONE 2026-10-20, `feat/client-reattach`):** `docs/feat/client-reattach.md` · L · load-bearing
      8b. **Feat (DONE 2026-10-20, `feat/client-reattach-frontends`):** `docs/feat/client-reattach-frontends.md` · M · load-bearing
      9. **Eval:** `docs/eval/session-handoff.md` — continue a `serve` session from another device (owner requirement 2026-10-20: mobile → TUI, live) · L → split · load-bearing
      — **Eval:** `docs/eval/attachments.md` (sister) · 4 sub-tasks · load-bearing
      — **Feat (DONE 2026-10-20, `feat/pod-attach-resilience`):** `docs/feat/pod-attach-resilience.md` — Layer 1: exec-channel keepalive (WS ping + blank stdin + pong-gated dead-man) · S · contained
      — **Eval (DECIDED 2026-10-23):** `docs/eval/mobile-app.md` — iOS-first React Native (Expo) app: E2E-encrypted
        channel over the tentacle.so relay / Tailscale / cloudflared / own domain, per-computer QR pairing, E2E push
        + Live Activity in v1. 21 owner decisions; 19 tasks + TestFlight in 7 phases (decision 21). Task 0 DONE
        2026-10-23 (`feat/mobile-spike`, `docs/feat/mobile-spike.md`); task 1 (`feat/session-list`) executing;
        plans ready: 1, 8; planning: 4. Absorbs the open questions of 9. Type: eval → feat · Size: L → split · Blast: load-bearing
      — **Eval (deferred, low):** `docs/fix/reaper-gc-flaky-test.md` — test-only flake, at the end of v2

- [x] **`connect` cannot trust a self-signed daemon** (`serve --tls-cert/--tls-key`
      gives `wss://`, but `connect` had no `--ca-cert` / `--insecure-skip-tls-verify`).
      DONE (2026-10-20, on `main`): `--ca-cert FILE` (trust anchor, PEM-validated) +
      `--insecure-skip-tls-verify` (dev-only); one `tls` object flows to the socket
      `init` and the classifying probe; a failed TLS handshake (close 1015) is named and
      the CLI points at the flag; TLS flags on `ws://` are an error.
      **Doc:** `docs/feat/client-tls-trust.md`. Type: feat · Size: S · Blast: contained.

- [ ] **Skills support (Agent Skills, `SKILL.md`)** — packaged procedural
      guidance the model opts into (skills = *how to do it*; the result pipeline
      = *the guarantee the context stays clean*). Next on the roadmap. Owner
      decisions recorded 2026-10-20; promotion-ready.
      Split into 4 feats: skills-core → skills-compaction → skills-slash /
      skills-subagent. **Eval:** `docs/eval/agent-skills.md`. Type: eval →
      feat ×4 · Size: L → split · Blast: load-bearing.
      - [x] **skills-core** (discovery, catalog, `skill` tool) — DONE
        2026-10-20, `feat/skills-core`: `docs/feat/skills-core.md`. Type: feat · Size: M ·
        Blast: cross-module.
      - [x] **skills-compaction** (active skills survive `/compact`, `SKILL.md`
        re-read) — DONE 2026-10-21, `feat/skills-compaction`: `docs/feat/skills-compaction.md`.
        Type: feat · Size: M · Blast: load-bearing.
      - [x] **skills-slash** (`/skill-name`: catalog on the wire, structured
        activation, protocol v7) — DONE 2026-10-21, `feat/skills-slash`:
        `docs/feat/skills-slash.md`. Type: feat · Size: M · Blast: load-bearing.
      - [ ] **skills-subagent** (`agent_task{skill}`: the parent passes the name,
        the sub-agent loads it before its first round) — eval written 2026-10-21,
        owner decisions Q1–Q8 open: `docs/eval/skills-subagent.md`. Type: eval →
        feat · Size: S–M · Blast: load-bearing (model-facing schema).

- [x] **Remove `TENTACLE_CWD` / config `cwd`: the launch folder IS the working
      folder** — DONE 2026-10-20, `feat/remove-tentacle-cwd`: `docs/feat/remove-tentacle-cwd.md`. (owner decision 2026-10-20, as in Claude Code / opencode / pi).
      Today AGENTS.md is found from the launch cwd (`config/src/load.ts:158,218`)
      while tools run in `TENTACLE_CWD ?? cwd ?? launch` (`config/src/resolve.ts:186`):
      rules from one folder, work in another. Scope: `resolve.ts:186`, the
      `cwd` key in `config/src/schema.ts:72` (top-level + profiles; **not** the
      MCP server `cwd` at `:51`), the scaffold comment `defaults.ts:97`, help
      `cli/src/main.ts:122`, `README.md:60`. A config file that still has `cwd`
      gets a clear error, not silent ignoring (pre-public, no shim). The cli tests
      that isolate via `TENTACLE_CWD` (`main`, `worker`, `args`, `wiring`,
      `profile-flag`, `serve-*`, `fixtures/worker-exit-net.ts`) move to
      `loadConfig({ cwd })` / a spawned child's `cwd`. Prerequisite for
      `feat/skills-core` (one discovery root). Type: feat · Size: S–M · Blast:
      cross-module · Suited: weaker model OK + standard review.

- [ ] **No changelog discipline** (no `CHANGELOG.md`). **Eval:**
      `docs/eval/changelog-discipline.md`. Type: eval. Open.

- [x] **Per-project config** (`.tentacle/config.jsonc` in the launch folder
      overrides the user config). **Eval:** `docs/eval/project-config.md` —
      REJECTED by the owner (2026-10-20): an implicit project file is launch-time
      code execution / key exfiltration. Replaced by the item below.
- [x] **Named config profiles** (`tentacle --profile <name>` / `TENTACLE_PROFILE`):
      `profiles` in the user's `config.jsonc`, merged over it (connection group
      as a unit; MCP servers by name, `null` removes). DONE 2026-10-20,
      `feat/config-profiles`: `docs/feat/config-profiles.md` · S–M · cross-module.
- [x] 🟡 **Unknown CLI flags are never rejected; `-n` is not a namespace.** FIXED
      2026-10-20, `fix/cli-strict-args`: `docs/fix/cli-strict-args.md` — one closed
      spec per command; flags anywhere (`attach mypod -n dev`); typos, missing
      values, repeats and stray words are errors before any cluster/model call.
      Type: fix · Size: S–M · Blast: cross-module.
- [x] **No `tentacle update`** (self-update from GitHub releases + the pod
      binaries). All decisions D1–D8 taken 2026-10-22; ships in **v0.1.0**.
      **Eval:** `docs/eval/tentacle-update.md`. Type: eval → feat ×3 · Size: M
      overall · Blast: cross-module. Children, in order:
      - [x] **pod-binary-download** — DONE 2026-10-22 (`feat/pod-binary-download`, `docs/feat/pod-binary-download.md`): version marker in the binary, download +
        SHA-256 verify helper, `run`/`attach` offline error on a missing/stale
        pod binary. Type: feat · Size: S–M · Blast: cross-module.
      - [x] **tentacle-update** — DONE 2026-10-22 (`feat/tentacle-update`, `docs/feat/tentacle-update.md`): `tentacle update [--check] [--version vX]`:
        staged download, verify, atomic rename (self last). Type: feat · Size: M
        · Blast: cross-module.
      - [x] **release-script** — DONE 2026-10-22 (`feat/release-script`, `docs/feat/release-script.md`, `docs/RELEASING.md`): `bun run release <version>`: bump every
        `package.json`, CHANGELOG `[Unreleased]` → version, commit + tag.
        Type: feat · Size: S · Blast: contained.
      - [ ] 🔵 **Later hardening:** Ed25519-signed `SHA256SUMS` verified by
        `update` (D3 deferred).
- [x] **Extensibility: users extend tentacle themselves (hooks + packages)** —
      out-of-process hooks (`tool_call` → `PermissionGate`, `tool_result` →
      result pipeline, `turn_start`, `turn_end`, `model_request`) + declarative
      packages; no in-process API, no pi/Claude Code compatibility. Eval written
      2026-10-21, owner decisions D1–D12 and all child sub-decisions recorded;
      5 children, each with a drafted Implementation, promoted in order
      (tool-naming first). **Eval:**
      `docs/eval/extensibility.md`. Type: eval → feat ×5 · Size: L → split ·
      Blast: load-bearing.
      - [x] **tool-naming** (CamelCase display labels only, names in code
        unchanged; shared `toolLabel` in core; first, hooks-core's H1 line needs
        it) — DONE 2026-10-22 (`feat/tool-naming`):
        `docs/feat/tool-naming.md`. Type: feat · Size: S · Blast: contained.
      - [x] **hooks-core** (config `hooks`, `stdin` in core, `HookRunner`,
        `tool_call` → `PermissionGate`, `tool_result` → pipeline; TUI line
        `⎿ hook <name> blocked <Tool>`) — DONE 2026-10-22 (`feat/hooks-core`): `docs/feat/hooks-core.md`. Type: feat ·
        Size: M · Blast: load-bearing.
      - [x] **hooks-turn** (`turn_start`, `turn_end` + continue ≤3,
        `model_request` notify; protocol 8 → 9) — DONE 2026-10-22 (`feat/hooks-turn`):
        `docs/feat/hooks-turn.md`. Type: feat · Size: M · Blast: load-bearing.
      - [x] **hooks-project-trust** (`.agents/hooks.json`, `hooks/trust`
        daemon→client, laptop store for the local worker only, auto-approve
        excluded) — DONE 2026-10-22 (`feat/hooks-project-trust`): `docs/feat/hooks-project-trust.md`.
        Type: feat · Size: M · Blast: load-bearing (§7).
      - [x] **packages** (own format; path + git; `tentacle package …` (alias `tentacle install`); not in
        pod v1) — DONE 2026-10-22 (`feat/packages`): `docs/feat/packages.md`. Type:
        feat · Size: M · Blast: cross-module.
        - [ ] 🔵 **Debt: no 64-char MCP tool-name warning in the TUI** (K2). It is
          printed only in `--plain` / one-shot mode (`cli/src/main.ts`, after
          `connectMcpServers`). The TUI connects MCP in the worker, which has no
          warning channel (a raw write would corrupt Ink, §7). Route it through
          the worker's MCP status (`McpStatusTracker` / `mcp/status`). Type: feat
          · Size: S · Blast: contained.
      - [x] 🔴 **In-process trust path skips the `hooks/trust` schema** (DONE 2026-10-22) — in the
        `--in-process` TUI and the worker fallback, `askHooksTrust`
        (`cli/src/wiring.ts:308-324`) calls the resolver with no
        `HooksTrustParamsSchema` check, so a project hook over the wire limits
        (5,000-char command reproduced) is offered, trusted and loaded.
        Found by the `docs/extensions.md` accuracy review. **Doc:**
        `docs/fix/in-process-hooks-trust-schema.md`. Type: fix · Size: S ·
        Blast: load-bearing (§7 trust).
      - [x] 🔵 **No package-dir / repo-root pointer for hooks and MCP servers** —
        hooks run in the session cwd with no env var naming their package dir
        or the project root, so a package or project hook launched from a
        subfolder can't find its own script by relative path. DONE 2026-10-22 (`feat/hook-env-dirs`): `TENTACLE_PROJECT_DIR` / `TENTACLE_PACKAGE_DIR`, `docs/feat/hook-env-dirs.md`. Type: feat ·
        Size: S · Blast: contained.
      - [ ] **Hook model access (LLM-judge seam)** — hooks call a model
        through tentacle (unix-socket HTTP + per-invocation token), judge
        model from a laptop-side `hookModels` map, resolved and capped on the
        laptop; in a pod via a new daemon→client `model/complete` (keys never
        leave the laptop). Owner decisions M1–M8 open. **Eval:**
        `docs/eval/hook-model-access.md`. Type: eval → feat · Size: L (split
        A local / B pod+protocol) · Blast: load-bearing.
      - [x] **protocol-v10-forward-compat** (protocol 9 → 10). Strip schemas
        and a tolerant JSON-RPC envelope. Unknown update kinds become
        `unsupported`. Update classes are display / mandatory / blocking, and
        blocking kinds are gated by the `initialize` list. The `hooks/trust`
        `model` field is reserved. DONE 2026-10-22 (`feat/protocol-v10-forward-compat`):
        `docs/feat/protocol-v10-forward-compat.md`. Type: feat · Size: M ·
        Blast: load-bearing (protocol).
        - [ ] 🔵 **Nit: re-check pending asks after a throwing send** — a client
          whose send throws in `emit` is dropped without `recheckAsks()` (needs a
          programming error; next attach/detach re-checks). Fix: one
          `recheckAsks()` after the fan-out loop (never inside: `settle` emits).
          Also optional: default `requestTimeoutMs` for requests to a pod.
          Type: fix · Size: S · Blast: contained.
      - **User guide:** `docs/extensions.md` (hooks + packages, worked examples).

- [x] **Send now (`Ctrl+X Ctrl+S`)** — interrupt the running turn (stream,
      tools, a pending permission, a hook or `/compact`) and send this client's
      queued messages as one prompt, atomically via a new `session/send_now`
      (additive in protocol 10). Owner decisions S1–S3, D1–D5 taken; D3c (queue
      locally during `/compact`) confirmed 2026-10-22. **Eval:**
      `docs/eval/send-now.md`. Type: eval → feat ×3 · Size: L → split · Blast:
      load-bearing.
      DONE: 4a daemon (`docs/feat/send-now-a.md`), 4b client
      (`send-now-b.md`), 4c TUI (`send-now-c.md`, merged 2026-10-24, tried
      by the owner by hand), 4d compaction-time queue (`send-now-d.md`, merged
      2026-10-24). Send-now COMPLETE.

- [x] **Version mismatch: say who is older and what to do — never a silent
      failure** (owner, 2026-10-24). Today the daemon refuses `initialize`
      with `protocol version mismatch: client 10, daemon 11` (code
      `VersionMismatch`, `daemon/src/connection.ts`); the owner likes the
      line — keep it and add, on the SAME line, each side's tentacle version
      and the action. Wording (owner-approved; commands in double quotes so
      the command stays clear inside the sentence):
      - client older: `protocol version mismatch: client 10 (tentacle 0.1.0),
        daemon 11 (tentacle 0.2.0) — update this client: "tentacle update"`
      - daemon older: `protocol version mismatch: client 11 (tentacle 0.2.0),
        daemon 10 (tentacle 0.1.0) — update the daemon: run "tentacle update"
        on that host and restart "tentacle serve"`
      The DAEMON writes the advice (it knows both numbers — a fact, not a
      guess), so even an old client that prints the message verbatim shows
      it. A new client meeting an old daemon (no versions in the error) still
      shows a clear notice from the error CODE, never by parsing the text.
      **Container (`attach`):** say "container", not "pod". `attach` already
      probes `tentacle --version` in the container and today reuses whatever
      answers; instead, when that version differs from the laptop's, REPLACE
      it with the laptop's binary (the same injection used when none is
      there) and say so, e.g. `the container had tentacle 0.1.0; replaced
      with 0.2.0 (this laptop's)`; if the replacement fails, a clear error
      with the advice. `run` creates its pod with the laptop's binary, so no
      mismatch there. Verify every path shows it (`connect` at start, a
      reconnect after the daemon was upgraded — the TUI link status —,
      `attach`, the app later). Order: BEFORE 2a (2a bumps the protocol to
      11 — the first time it will happen). **Planned 2026-10-24** (slug
      `version-mismatch-notice`, plan in the gitignored plan folder, awaiting
      the owner → **APPROVED 2026-10-24**, **DONE 2026-10-24** (`docs/feat/version-mismatch-notice.md`, merged `90c22af`): container older → `… — update the
      container's tentacle: run "tentacle attach" again from an up-to-date
      laptop (it replaces an older one)`; daemon without versions → "the
      daemon runs an older tentacle" (a deduction pinned by a test); `attach`
      from a dev build → reuse the container's tentacle as today): re-sized M
      · cross-module; optional `clientInfo` on
      `initialize` (malformed = absent, never fails `initialize`) + a
      structured `data` on the `VersionMismatch` error; no `PROTOCOL_VERSION`
      bump. Findings: `run` CAN mismatch with a dev build or
      `TENTACLE_POD_BIN`; the TUI status line truncates the advice
      (`StatusBar.tsx:90`) → also a notice on reconnect; `attach` installs via
      a temp file + `mv` (overwriting a running binary fails with
      `ETXTBSY`); constraint for 2a: `initialize` params must stay readable
      by every daemon, or an `InvalidParams` would hide the mismatch.
      **Executed 2026-10-24** on `feat/version-mismatch-notice` → task doc
      [`docs/feat/version-mismatch-notice.md`](docs/feat/version-mismatch-notice.md)
      (Execution filled; Review pending).

- [x] **`bun run compile` refused its own binary: two version markers**
      (found 2026-10-25 by the owner building locally) — DONE
      (`docs/fix/double-version-marker.md`, merged `6b07818`). Since
      `19fa201` the worker (a second compile entrypoint) imported
      `APP_VERSION`, so the marker was inlined twice; the main thread now
      sends the version in the worker bootstrap. Sonnet executed, fresh Opus
      review MERGE. Debt: no test pins that the main thread sends
      `APP_VERSION` (review finding 1).
- [x] **TUI: sent messages on a full-width background; queued messages
      look sent, in grey** (owner, 2026-10-25) — **DONE 2026-10-25**
      (`docs/feat/tui-message-style.md`, merged `89b1364`; built in PARALLEL
      with task 5 at the owner's request; also compact token totals `1k` /
      `1.2k` / `1M` and timers `1m 50s`, owner 2026-10-25; light palette
      present but unselected until theme selection exists) — `feat/tui-message-style`,
      S · contained, Sonnet executes, Opus reviews; runs right AFTER task 5
      (`feat/queued-broadcast`) merges (both touch the TUI queue rows; one
      code branch at a time).
      - **Sent user message:** every line of it on a background colour that
        spans the whole terminal row, left edge to right edge ("così sarà
        anche più facile individuarli quando si scrolla una sessione
        lunga"). Today only the `›` is coloured (`render-lines.ts`
        `userLines`). The tint comes from the theme: subtle on dark, a
        matching light tint on light themes; wrapped lines and blank lines
        inside the message keep it.
      - **Queued messages:** the rotating arc goes away. Each queued message
        sits at the bottom of the conversation, just above the input, shaped
        exactly like a sent message (same `›`, same row background); the ONLY
        difference is the text colour: grey (the theme's subtle colour)
        instead of the normal text colour (white on dark). Further queued
        messages stack below it, one per row; under the last one, in grey as
        today, "ctrl+x ctrl+s to send now". While the turn streams, the
        model's output grows above them; they stay pinned at the bottom.
      - **When it is delivered** (the daemon says so — the steer reached the
        model, `TurnEnd.delivered` / the steer event — never a client guess)
        the message turns to the normal text colour and stays in the
        conversation at the point where the model received it.
      - Logic (which rows, which state) in a pure module; the component only
        maps it to colours. Tests on frames (ink-testing-library), plus a
        theme check for dark and light.
- [x] **TUI: syntax colours in file reads, by the file's language** (owner,
      2026-10-25) — **DONE 2026-10-25** (`docs/feat/tui-read-highlight.md`,
      merged `d27c1ca`; Sonnet executed, two fresh Opus reviews; plain above
      `READ_HIGHLIGHT_CAP` = 2000 lines / 200 KB, an orchestrator default the
      owner may change; html/xml left plain, since their `<script>`/`<style>`
      blocks would need content detection) — `feat/tui-read-highlight`, S · contained, Sonnet
      executes, Opus reviews; runs AFTER task 5 merges (same
      `render-lines.ts`). A `Read` result (preview AND the ctrl+o expanded
      view) is coloured by the language of the file it read — Go, Python,
      JS/TS, Markdown, YAML, shell, Rust… — using the `cli-highlight`
      (highlight.js) dependency the TUI already has for markdown code blocks.
      - Language from the file EXTENSION, never content auto-detection (slow
        and wrong); unknown extension → plain text as today.
      - Computed once per tool item and cached with the existing line cache,
        never re-highlighted on scroll; colours follow the theme (dark /
        light). Measure the cost in the task (estimate: ~1 ms for a 40-line
        preview, tens of ms once for a 1000-line expand).
      - Known limit, accepted: a preview cut starting inside a multi-line
        comment/string may colour its first lines wrongly (cosmetic).
      - Later, not now: the same colouring inside edit diffs (green/red bars).
- [x] **TUI: a spilled tool result shows a short note, not the model's banner**
      (owner, 2026-10-25) — **DONE 2026-10-25** (`docs/feat/tui-spill-note.md`,
      merged `2dd5a36`; Opus executed, fresh Opus review MERGE; daemon record v5;
      the model's no-path banner is now tool-aware; a v4 record holding `spill`
      is accepted, harmless, left as is) — `feat/tui-spill-note`, L · load-bearing (record v5,
      persisted `spill` field; owner-approved plan), Opus executes, fresh Opus review; runs BEFORE task 6
      `tui-foreign-turns`. Today a too-large tool result shows the banner meant
      for the model (`[large fs_read output: full output (N chars) saved to
      .tentacle/tool-output/… do NOT read it whole]`, built in
      `packages/agent/src/result-pipeline.ts` `spillLargeOutput`).
      - The model keeps the banner unchanged.
      - The daemon flags the result structurally (an additive field: spilled,
        chars, path) — the TUI NEVER parses the banner text (owner principle:
        the client never guesses). It must also hold on resume / reload from
        history (persisted or derivable from a fact, never from text).
      - TUI text in ENGLISH (owner). Normal view: a grey line
        `40.8k chars · too large, the model reads it in parts`, then the
        head/tail preview, syntax-coloured as in `tui-read-highlight`, with
        the usual `… +N more lines · ctrl+o to expand`.
      - ctrl+o: the grey line, then `saved to <path>` (in a pod:
        `saved in the pod to <path>`), then the full head, `… N chars
        omitted …`, the full tail. The path is shown ONLY in ctrl+o (owner).
      - Same for every tool that spills (shell too), not only `fs_read`.
      - The "could not be saved" case (no path) says so, without a path.
- [ ] 🔵 **`/save` still exports the model's spill banner** (Review of
      `tui-spill-note`, 2026-10-25) — the export writes the raw tool content
      (`[large … output: …]` + preview); it could use the structured `spill`
      field like the TUI does. Decide whether an export should show what the
      model saw (today) or the user-facing note. S · contained.
- [ ] 🔵 **TUI: Fn+Delete (forward delete) deletes BACKWARD** (found in the
      `fix/tui-input-wrap-cursor` Review round 2, 2026-10-25; pre-existing) —
      Ink 5.0.1 reports `\x1b[3~` (Fn+Delete) like `\x7f` (Backspace), so the
      prompt deletes the character before the cursor; Alt+Fn+Delete
      (`\x1b[3;3~`) deletes the previous word instead of the next. Needs the
      raw sequence (Ink's `useInput` does not expose it) — check
      `docs/library-bugs.md` and Ink's parser first. S · contained.
- [ ] **Permission prompt: "No, let's talk about it"** (owner, 2026-10-24) — a
      third answer next to Yes / Yes, always / No: it opens a text field; the
      model gets the rejection TOGETHER with the user's text (e.g. "Rejected
      by the user: why do you need to delete build/? Try just bun run build
      first") and the turn CONTINUES — the agent answers or changes plan, and
      asks again if it still needs the tool. Unlike `Ctrl+X Ctrl+S` (stops the
      turn, sends the queue), the text answers that one request. Shape: an
      optional text on the permission answer (additive, no
      `PROTOCOL_VERSION` bump); the text leaves the laptop like every answer,
      so it holds for every target. Order: after send-now 4d, before the app's
      tasks (task 13's approvals inherit it). **Planned 2026-10-24** (slug
      `permission-reply`, awaiting the owner): re-sized M · load-bearing. **DONE 2026-11-04, merged `1ee6123`** (rebased onto main, record v8 shared with parallel task 5). A
      rejection already does not end the turn (it becomes the call's `tool`
      result and the model runs again — proved), so only the rejection's
      content changes. Wire: `permission_request.reply?: {maxChars}` (the
      DAEMON declares the request accepts a text — the client never guesses)
      and `session/resolve_permission.message?` (≤ 2000 chars, no control
      chars but `\n`/`\t`); no bump. Rejected: a new option kind (an older
      client could no longer parse the whole blocking update); sending text
      to an older daemon (it would drop the user's words silently).
      **APPROVED by the owner 2026-10-24:** the model sees today's rejection,
      then `The user replied:` + the text, then one guidance line; empty text
      + Enter = a plain No; **Shift+Tab while typing turns auto-accept on AND
      approves the request being answered** (owner's change; the draft moves
      to the main input with a notice, never lost); a request withdrawn while
      typing (send-now, cancel, another device) → the draft moves to the main
      input with a notice.
- [ ] **The model cannot ask the user a structured question** (owner, 2026-10-30):
      today it can only ask in plain text, which ends the turn. Proposal: an
      `ask_user` tool — one call carries 1–4 questions (short header, 2–4
      options with a description each, recommended first, single or multi
      choice, always a free-text "Other"); the TUI shows a form (one tab per
      question, ←/→ between questions, ↑/↓ choose, space toggles a multi choice,
      Enter confirm, Esc cancel, summary before send); the answers return as
      the tool result and the turn goes on. The tool description + system
      prompt teach when to use it (blocking decisions only; in planning, bundle
      independent questions into one form; always recommend; never ask what the
      model can verify itself). No one to answer (detached run, one-shot, a
      client that did not declare it) → immediate fallback result "no user:
      proceed with the recommended options and state your assumptions"
      (AGENTS §7 *blocking* update: declared + fallback). **Disableable, like
      every other tool, default enabled** — there is no per-tool disable today
      (`config/src/schema.ts` `tools` holds only output options), so the eval
      also decides a generic one (e.g. `tools.disabled: [names]`, per profile).
      Split: (1) tool + protocol + fallback + disable switch, (2) TUI form,
      (3) mobile app. Ties in with detach (a detached run takes the fallback).
      **Eval:** to write (`docs/eval/ask-user-tool.md`), after detach.
      Type: eval → feat · Size: L → split · Blast: load-bearing.

### Block 9 — open legacy plans (moved out of `docs/` root, 2026-10-17)

Pre-§10 docs with no TODO entry until now; not sized yet (size them when picked up).

- [x] **`tentacle attach` dies after idle** (`⚠ RpcError: peer is closed`):
      reconnect done (8b); keepalive (Layer 1) DONE 2026-10-20
      (`feat/pod-attach-resilience`). **Doc:** `docs/feat/pod-attach-resilience.md`.
      Type: feat · Size: S · Blast: contained.
- [ ] **Self-deleting injected binary on `attach`** (leave-no-trace on a
      user-owned pod). **Eval:** `docs/eval/pod-ephemeral-binary.md`. Type: eval.
- [ ] **React 18 → 19 + Ink 5 → 8** (want-driven, retires two workarounds).
      **Eval:** `docs/eval/react-19-migration.md`. Type: eval.

## Roadmap (ordered)

> **Owner queue (2026-10-25, updated 2026-10-26), next code tasks in this order:**
> 1. ~~task 7 `connect-sessions`~~ DONE, merged `6319beb` (2026-10-26; `docs/feat/connect-sessions.md`);
> 2. ~~`context-awareness`~~ DONE, merged `867a4d0` (2026-10-26; `docs/feat/context-awareness.md`; record v7);
> 3. `context-reset` (`docs/eval/context-reset.md`; re-planned 2026-10-26,
>    3 branches; owner answered CR-Q1/CR-Q2; takes record v8 if it needs one) —
>    slice 1 `feat/context-reset-refresh` DONE, merged `e58d8bf`; slice 2
>    `feat/context-reset-barrier` DONE (protocol v12), merged `031cb52`; slice 3
>    `feat/context-reset` DONE, merged `5fe4d20` (review MERGE; F1 `/compact`
>    resets the `model_request` hook baseline; `[context]` diagnostics). DEBT
>    (slice-2 review F1, owner 2026-10-26): after a `serve` crash right after
>    the barrier, a reloaded send-now answers the restart prompt while in
>    memory it is refused — mark the reset head in the record at the NEXT
>    record bump (permission-reply's v8). Unverified: a real reset under pod
>    `run`/`attach` and across a `serve` restart.
> 3b. skills hot-reload for the USER (`/name` list + `/skills` panel follow a
>    reset / new skill without restart) — DONE, merged `067cd49` (protocol v13; D1 owner-accepted; small debt in `docs/feat/skills-hot-reload.md`);
> 4b. **Detached runs** (**S1 `pod-daemon-resident` DONE, merged `9f17376` 2026-10-30, no tag**; **S2 `detached-relay` DONE, merged `e7620d7` 2026-10-31** (live 17/20, items 3, 8, 17 carried to S2b); **S2b + S4 `detached-relay-lifecycle` DONE, merged `4f0fc2f` 2026-10-31**; **S3 `detached-handover` DONE, merged `9ec10d1` 2026-10-31** ([task doc](docs/feat/detached-handover.md); fresh Opus Review + Opus fix + DeepSeek fix; live items 27–57 in the S2b checklist), then the owner's one hand-run live checklist; S5 `/detach` + `adopt` left;  release with protocol 14 after S3 — task doc [`docs/feat/detached-runs.md`](docs/feat/detached-runs.md)) (owner 2026-10-27, draft — eval [`docs/eval/detached-runs.md`](docs/eval/detached-runs.md) written, DR-1…DR-9 DECIDED by the owner 2026-10-27; still to verify: k8s exec survival; AFTER docker E). Leave a `run` working with no TUI and re-attach later. The model stays on the laptop (AGENTS §7), so a detached run needs a LAPTOP-SIDE background relay (keeps the `model/stream` proxy + the single permission broker + session persistence alive without Ink); it stops if the Mac sleeps/powers off.
>    - CLI: `tentacle run --detach` — open question: only in one-shot mode (prompt given on the command line) or also as "start interactive, detach later"? + `--auto-accept[=true|false]` to launch detached with auto-accept on (explicit opt-in; a detached run with auto-accept off would stall on the first permission — say so in the message).
>    - TUI: `/detach` — leaves the session running in the background relay and exits the TUI cleanly (pod/container kept). Requirement (owner 2026-11-06): after `/detach` the relay's auto-wake (fix/detached-autowake + fix/autowake-unbounded) must work on the handed-over session — pin it with a test.
>    - Re-attach: `tentacle attach <name>` (slice E resolves engine/location) reconnects the TUI to the relay; `tentacle ps` shows a DETACHED/ATTACHED state + last activity.
>    - To decide: relay lifetime (until the turn ends? until `rm`?), where its logs go (never the terminal), notifications on finish (mobile app task 17 later), what `--keep=false` means for a detached run (delete when the relay ends).
> **DONE 2026-11-02, merged `e9a1e30`:** mobile app task 8 `feat/e2e-channel` (Noise IK secure channel, `docs/feat/e2e-channel.md`) — 2 fix rounds, Hermes check passed on the iOS simulator (1 MiB frame ~0.8 s: task 11). Wanted debt: binary WS frames before the app ships.
> **DONE 2026-11-02, merged `0edf0be`:** `fix/detach-live` (`docs/fix/detach-live.md`, L · load-bearing) — 10 fix rounds, live re-run green + owner item 12 (lid) passed; gate on main after merge 4082/3/0, lint 0. **Follow-up `fix/detach-live-followups`** (S–M): Q8 marker for a turn cut mid-stream by a lone `/quit`; Q11 delete the Q6 aside files with the session/`rm`; Q12 per-file lock for the store guard window; Q13 a failed keep=true run also shows `not saved`; comment that R9 relies on the synchronous idle flush; `--model` flag on attach (Q-A1); drop the `RpcError:` prefix in the TUI error line; `↑0 ↓0`/ctx 0% after a failed turn; `rm` with several names; prune or hide `gone` rows in `ps`. Q9 (revision counter in the laptop record) rides `permission-reply`'s record bump; Q-B1/Q-B2 (keep partial text on Esc / close mid-stream) ride `feat/resume-after-model-loss`.
>
> **DONE 2026-11-04, merged `8570e25`:** `fix/detach-live-followups` (`docs/fix/detach-live-followups.md`) — the follow-ups above (Q8 closed with evidence → Q-B1; Q12 deferred) plus owner 2026-11-03: `--model`/`--profile` are flags ONLY of the session commands (`run`, `attach`, `serve`, bare `tentacle`), written after the command; empty `ps` prints only the header. 4 rounds (exec Opus ×2 + Sonnet ×2; reviews Opus ×3 + one quick check). Spec of the target behaviour: `docs/attach-detach-behaviour.md` (awaiting the owner's review).
> 4g. **Order agreed with the owner (2026-11-01):** (1) close detach — `fix/detach-live` (fix round, live re-run incl. owner item 12), release (protocol 14), S5 `/detach`, then the attach/detach/quit cases document (Italian, from the as-built code); (1b) `feat/resume-after-model-loss` (also **Q-N1**: a turn that fails before its first event must still be read back and saved on the laptop — today it is not, and a keep=true run then shows no `not saved`; the F6 test in `relay.test.ts` pins today's behaviour; owner 2026-11-02, after the lid live test: a model stream lost mid-reply — e.g. laptop sleep — pauses the turn, waits for the network (bounded), then continues keeping the partial text, no duplicates, with a visible "connection lost … resumed" note; the cut-and-show path of fix/detach-live round 10 stays the fallback); (2) `permission-reply` (item 6) together with **attachments sub-task 1** `feat/attachments-history` (`docs/eval/attachments.md`, plan of 2026-10-19 to refresh against today's main) — both bump the session record, so one bump or back-to-back; (2b) parallel execution tasks 5 `feat/round-groups-persistence` → 6 `feat/parallel-tools` → 7 `feat/parallel-agents` (owner 2026-11-02: right after permission-reply; 5 also bumps the session record, coordinate with (2)); (3) attachments sub-tasks 2–4 (store, prompt block, TUI paste/path); (4) mobile app task 9 onward. In parallel (disjoint files): mobile task 8 `feat/e2e-channel` (in review), UI mockups approved (`docs/eval/mobile-app.md`). App attachments stay after v1 (decision 11).
> 4c. **Session log format: JSON vs JSONL** (owner 2026-10-27; eval `docs/eval/session-log-format.md`, AFTER the shared record v8 of permission-reply + task 5 is merged). Today both stores rewrite the whole record per turn (temp file + rename, `agent/src/session-store.ts`); pi and Claude Code append one JSON line per message. Weigh: write cost growing with session size (largest local records ~600 KB), crash loses the whole in-flight turn vs only the last line, streaming tools (`tail -f`/`jq`), full history kept after compaction/context-reset (mobile "review everything"), versus today's simplicity (file = state, strict whole-record `schemaVersion`, in-place fields like title/archive/`pending[]`).
> 4d. **Docker live-test bugs** (owner's first `run --engine docker`, 2026-10-27; fix task `fix/pod-binary-staleness`, S–M): (1) a STALE prebuilt pod binary in `<configDir>/bin/tentacle-<target>` (22 Oct) was injected silently — every build says `0.1.0`, so neither `run` nor `attach`'s replace-older-tentacle notices; the old daemon died on `unknown option --context-window` → compare a build id (content hash / commit) not the version string; (2) that daemon stderr never reached the user: only `[container] failed: connection closed` (AGENTS §7 says buffered daemon stderr is flushed on the pre-mount failure path — it was not); (3) the `kept <name> — resume with …` line is printed TWICE — on failure AND on a normal Ctrl+C exit of `run` (owner repro: `tentacle run --engine docker --image node:22`, then Ctrl+C).
> 4e. **`ps`/`rm` follow-ups** (slice E review, 2026-10-27; S): (1) same name on the same engine in two locations (two k8s contexts/namespaces) → `rm` cannot pick one and wrongly suggests `--engine`; add `--context`/`--namespace` filters and print the exact command to re-run (`kept.ts:325`, `kept-cmd.ts:160`); (2) re-attaching to an indexed k8s cluster uses today's `TENTACLE_K8S_TOKEN`, possibly another cluster's (`engine-select.ts` `buildEngineHost`); (3) nit: no uid check between label re-read and delete (`kept-cmd.ts:210-215`); (4) OWNER QUESTION (recommend yes): should `ps` also scan local docker/podman for kept containers missing from the index (created before E or on another machine)?
> 4f. **CI on every push** (owner 2026-10-27; S): `.github/workflows/build.yml` runs only on `v*` tags, so nothing runs `bun run check` on push/PR — add a workflow (install with `--filter '!@tentacle/mobile'`, the three opt-in skips stay skipped), then add a "build passing" badge to the README.
> 4. `docker-runtime` (slice A `feat/docker-engine-client` DONE, merged `116d45f`; A2 `feat/docker-ssh-dialer` DONE, merged `1168217`; B `feat/docker-engine-seam` DONE (EngineHost); C `feat/docker-engine-cli` DONE (merged today: `--engine`, `engine:` user config/profiles/`TENTACLE_ENGINE`, podman socket, `--keep[=true|false]` + `keep:` config, DEFAULT TRUE (owner 2026-10-27)), then D `feat/docker-workspace-mount` (cwd bind-mount, masks, y/N gate, labels for E — DONE 2026-10-27, merged (commit `6d1fa2c`; 3 review rounds, case-insensitive file-mask refusal verified live); follow-up: a copy/sync workspace for a remote engine, owner M3), then E `tentacle ps` / `tentacle rm <name>` for kept containers/pods (owner 2026-10-27) — E `feat/engine-ps-rm` DONE 2026-10-27, merged (commit `904a6e9`; review MERGE, live-tested ps/rm on Docker Desktop) (laptop index, one file per workload; `attach <name>` resolves), awaiting the mandatory fresh-context Review ([`docs/feat/engine-ps-rm.md`](docs/feat/engine-ps-rm.md))) — `run`/`attach --engine kubernetes|docker|podman`, default configurable (owner 2026-10-26) (`docs/eval/docker-runtime.md`,
>    owner answers 2026-10-26; promote to `feat/` when picked; slices A
>    `packages/docker`, B neutral `SandboxHost` seam, `ssh://` dial-stdio, C CLI/docs);
   - FUSE name-filter for hidden files on case-insensitive filesystems (agent non-root; removes the refuse rule) — [`docs/feat/docker-workspace-mount.md`](docs/feat/docker-workspace-mount.md) (fix round 2).
> 5. default `maxIterations` = `-1` (agent and sub-agents);
> 6. `permission-reply` ("No, let's talk about it"; plan of 2026-10-24 to
>    refresh against today's main);
> 7. parallel tools and parallel sub-agents (`docs/eval/parallel-tools.md`,
>    `docs/eval/parallel-agents.md`; evaluate first).
>
> **DONE 2026-10-26, merged `cf66a70`:** `fix/musl-image-detect` — musl /
> loader-less / unsupported-arch images fail before the transfer with a clear
> message (k8s now, Docker later; `docs/fix/musl-image-detect.md`).
>
> **DONE 2026-10-26** (merged, `fix/agent-defs-warn`, by the local tentacle agent):
> ~~**Debt (found in context-awareness, 2026-10-26):**~~ `parseAgentDefinition`
> (`packages/agent/src/agent-defs.ts`) silently ignores an invalid `model` or
> `contextWindow` in a sub-agent's frontmatter — surface it (a load warning),
> never a silent drop. Type: fix · Size: S · Blast: contained.
> Then the mobile app tasks resume (task 8 onward, `docs/eval/mobile-app.md`).
>
> **Eval open (owner, 2026-10-26):** `docker-runtime` — `run`/`attach` on a
> local or remote Docker (Engine API `exec` over a hand-written HTTP/1.1
> upgrade, same JSON-RPC over another byte stream; `docs/eval/docker-runtime.md`).
> Owner questions answered; slotted as queue item 4 (after context-reset).
>
> **DONE 2026-10-26, merged `9511c0e`:** `fix/tool-duration` — Type: fix · Size: M · Blast:
> load-bearing (additive wire field + persisted `ChatMessage` format) ·
> Suited: Opus exec, fresh Opus review. A tool row rebuilt from history
> (`--resume`, reconnect, session switch, compaction replace) shows a fake
> `0.0s`: `messagesToItems` stamps `startedAt: 0`/`endedAt: 0`
> (`packages/tui/src/resume.ts:31,42`) and `toolLines` prints any defined
> `endedAt` (`render-lines.ts:489`). Repro: same `sleep 2` call → live
> `2.0s`, replayed `0.0s`. Owner decision (2026-10-26, option A): the daemon
> measures each tool call's duration and stores it on the tool `ChatMessage`
> as a metadata field like `spill` (never sent to the model: zero context
> cost), carried on the `tool_result` update; live AND replayed rows show it
> (also more exact over `connect`, where client receipt time adds network
> latency). A row whose duration is unknown (older records) shows NO time,
> never a fake `0.0s`. Plan must settle: record/store versioning for the new
> field (strict laptop parser), and sub-agent tool rows.
> **Status (2026-10-26):** plan approved and executed on `fix/tool-duration`
> — task doc `docs/fix/tool-duration.md`; `DAEMON_RECORD_VERSION` is now 6
> (context-awareness / permission-reply / parallel-tools renumber to 7+);
> fresh-context Review MERGE (APPROVE-WITH-NITS), gate 2789 / 2 / 0.

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
        Not yet done. **Audit 2026-10-19 — to verify with a repro:** the code
        already looks best-effort (`agent/src/agent.ts:474-480` catches the write
        and returns `null`; `result-pipeline.ts:74-77` keeps a preview + "could
        not be saved"), so the residual may only be "full output lost", not an
        error.
      - [x] **F4.g — `attach` to an existing pod** (branch
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
      primes only the MAIN session; a spawned subagent (the `agent_task` tool) still
      starts from its agent-definition body (`agent-defs.ts` → `prompt`), not the
      repo rules. Defensible — subagents are handed the executor/reviewer briefs,
      which order reading AGENTS.md — but undocumented, and it partly undercuts the
      weak-model motivation. Decide: inject AGENTS.md into subagent prompts too, or
      document that the briefs are the channel. Type: eval · Size: S · Blast:
      cross-module.
- [x] **Relabel "Task" → "Agent" + rename tool `task` → `agent_task`**: the
      display label and the model-facing tool name both read as "agent".
      **Promoted eval → feat** (2026-10-17, weak-model gate PASSED — no
      invocation degradation). **Merged to main (7344fbc).**
      **Doc:** `docs/feat/subagent-label-rename.md`. Type: feat · Size: S ·
      Blast: load-bearing (model-facing name).

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

- [ ] **MCP — full compatibility across both protocol eras** (2026-07-28 + legacy):
      reconnect & safe re-issue, tool-set change notifications, result content,
      warnings + version in `/mcp`, elicitation, OAuth — six tasks, in order.
      **Eval:** `docs/eval/mcp-full-compat.md` (owner-approved split; deprecated
      Sampling/Roots/Logging/HTTP+SSE excluded by decision). Transport + dual-era
      client: `docs/feat/mcp-remote-transport.md`.
- [ ] **MCP**: resources & prompts; MCP in the `serve` daemon; `headersCommand`
      (secret headers off the config file).
- [ ] **Sub-agents**: background / parallel execution (SA.d).
      **Eval:** `docs/eval/parallel-subagents.md` (open — leans background-first, must split; needs a use-case).
- [ ] **Parallel tool calls within a round** (today strictly sequential,
      `agent.ts:304`; pi, Claude Code and opencode all run them in parallel).
      **Eval:** `docs/eval/parallel-tool-calls.md` (**DEFER**, 2026-10-19: design
      ready — consecutive `shared` batches, serial prompts then concurrent run —
      but on 53 Qwen sessions only 4.3% of calls would go parallel, all
      ms-scale `fs_read`. Promote on: parallel sub-agents approved, a frontier
      model as regular driver, or network MCP becoming common).
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
      observers, `config.jsonc` `remote` block, operator docs. **Superseded**
      (heartbeat, reconnect, multi-client) by the protocol-v2 redesign
      `docs/eval/session-reattach.md` (children `session-ttl-limits`,
      `session-registry`, `client-reattach`); the `remote` config block and
      operator docs remain.
- [ ] Add `.tentacle/` to the workspace `.gitignore` guidance (spilled output).

## TUI polish

- [x] **Blinking bullet on a running tool call** — DONE (branch
      `feat/tui-tool-blink`, 2026-10-30): a running call's `⏺` blinks 500 ms
      on / 500 ms off from ONE shared clock, and turns into today's ok/error
      bullet when the call ends. **Doc:** `docs/feat/tui-tool-blink.md`
      (round-1 review by a different model found two HIGH defects — the OFF
      phase re-wrapped the row at 1 Hz, and a dead call blinked forever — both
      fixed and pinned in fix round 1). Type: feat · Size: S–M · Blast:
      contained · Suited: DeepSeek executes, Opus reviews.
- [x] **Blink OFF phase: hide the glyph instead of drawing blanks** — DONE
      (branch `fix/tui-blink-off-width`, 2026-10-30): on the owner's terminal
      the row shifted ONE column during the OFF half, because `string-width`
      calls `⏺` 2 columns and that terminal draws it 1 — no fixed count of
      spaces is right everywhere. The OFF phase now emits the SAME `⏺` under
      `chalk.hidden` (`ESC[8m … ESC[28m`), so the cells are identical to ON in
      every terminal and only visibility changes; colour-off/SGR-8-unaware
      degrades to a steady bullet. **Doc:** `docs/fix/tui-blink-off-width.md`.
      Type: fix · Size: S · Blast: contained · Suited: DeepSeek executes,
      orchestrator checks.
- [x] **Click a tool call to expand its command** — DONE (branch
      `feat/tui-tool-expand`, 2026-10-30, stacked on `feat/tui-tool-blink`): a
      left click (press + release on the same cell, no drag) on a tool call's
      header row toggles THAT call — the header keeps bullet + label + elapsed
      and the full command follows, wrapped, on `  │ ` rows under it; a second
      click collapses it. Ctrl+O shows every call's command too, and the
      collapsed subtitle is now cut to the header's real room at the current
      width (`string-width`) instead of a fixed 72. **Doc:**
      `docs/feat/tui-tool-expand.md`. Type: feat · Size: M · Blast: contained ·
      Suited: DeepSeek executes, Opus reviews (stacked on tui-tool-blink).
      The dead-call follow-up is `main`'s existing entry ("close a turn's
      still-running tool calls when the turn fails"), not a second one here.

## Branding

- [x] **Mascot "Tentacle"** — DONE (merged to main 2026-10-19): tonal primary
      and mono one-colour marks in `art/`, tonal mark centred in the README
      header. **Doc:** `docs/feat/mascot.md`. Type: feat · Size: S · Blast: contained.
- [ ] **Startup pixel mascot in the TUI** (`feat/tui-mascot`): half-block
      banner beside the welcome text; design + palette prototyped in
      `docs/feat/mascot.md` (Context). Type: feat · Size: S · Blast: contained.
- [ ] **Mascot follow-ups**: dark-mode README variant (`<picture>`), small-size
      icon (16–32 px). See
      `docs/feat/mascot.md` (Review).
