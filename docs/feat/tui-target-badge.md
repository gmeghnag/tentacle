# feat/tui-target-badge — target badge, model on the input border, context at open

> **Status:** review
> **Branch:** `feat/tui-target-badge`
> **Type:** feat · **Size:** M · **Blast:** cross-module · **Suited:** strong model executes; fresh-context Review (a new RPC pair + a provider seam)

## Context

*— claude-sonnet-5-5, 2026-11-05*

Owner decisions 2026-11-04/05 (`TODO.md`, authoritative), three parts:

1. **Badge.** In a container/pod the status bar shows, LEFT, an accent-coloured
   (not dim) badge: `docker tentacle-ba89d072 · ~/trash · …`, `podman …`,
   `pod <name>`, `pod <name>/<container>` only when the pod has more than one
   container. Local: nothing. Never truncated (the path shrinks first). The text
   comes from the LAPTOP (the engine host / kept entry), never from the pod.
2. **Model name** moves from the status bar to the input field's top border,
   right-aligned (`──── rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 ─`); too long
   → cut on the LEFT with `…`.
3. **Context at open.** ctx is ALWAYS shown with its max. Before this TUI
   measured a turn (fresh session, attach): the EXACT count where the provider
   can count without generating (Anthropic `count_tokens`; llama.cpp
   `/apply-template` then `/tokenize`), else the estimate (`estimateUsed`)
   marked `~` (`ctx █░░░░░░░░░ ~7% (~9k/128k)`); exact after the first turn.
   `↑ ↓` hidden until measured. Daemon-side, once at open/attach, never on the
   render thread; a count endpoint failing or slow (2 s cap) falls back to the
   estimate silently. In a pod run the count is done by the LAPTOP.

**Repro (feat: the capability is missing)** — on current `main`
(`packages/tui/src/components/StatusBar.tsx`): the bar renders
`<cwd> · ↑– ↓– · ctx –` + the model at its right end; no badge prop exists;
the input border (`App.tsx:2653-2660`) is a plain `round` border with no text;
before the first turn ctx reads `ctx –`. Pinned by the existing test
`app.test.tsx` F2 (`ctx –`, `↑– ↓–`), whose `ctx –` assertion changes here.

## Implementation

*— claude-sonnet-5-5, 2026-11-05*

### Load-bearing assumption

A new request method is additive: an unknown method is answered
`MethodNotFound` (`protocol` forward-compat rules, AGENTS §7), so an old peer
never breaks and the new asker treats `MethodNotFound`/any failure as "no
exact count → estimate". Verified: the tunnel already latches on it
(`daemon/src/proxy-model.ts:55-60`), and the client's request handler throws
`MethodNotFound` for any other method (`client/src/remote-client.ts:1067`).
So **no `PROTOCOL_VERSION` bump** (nothing changed or removed; `version.ts:7`
stays 15).

### Preconditions (verified)

- TUI is always over RPC: `SessionController` is a `RemoteSession`
  (`client/src/remote-session.ts`); a new optional `context()` follows
  `skills()` (`remote-session.ts:570`, `App.tsx:212`).
- A session is opened lazily at the first prompt (`remote-session.ts:564-569`
  comment), so "fresh session" has no daemon-side id: `session/skills` solved
  the same with an optional `sessionId` (`protocol/src/skills.ts:39-47`,
  `connection.ts:243-248`). `session/context` copies that shape.
- Requests are dispatched concurrently (`transport/peer.ts`, AGENTS §7): the
  count (≤ 2 s) never blocks a prompt/enqueue; it holds no lock.
- Model stays on the laptop: pod daemons reach the model only through
  `ProxyModelProvider` (`proxy-model.ts:154`) ↔ `RemoteClient.servingModel`
  (`remote-client.ts:1908`). The count rides the same tunnel
  (`model/countTokens`, daemon → client), served by the LOCAL provider, so the
  endpoint and key never leave the laptop. The pod can only ask "how many
  tokens is this text" — the same trust surface as `model/stream`, strictly
  weaker (no generation, no output); gated by the same `servingModel`.
- The request the loop sends is `messages.map(renderForModel)` + `tools.definitions()`
  (`agent/src/agent.ts:793-803`); `estimateUsed` (`context-awareness.ts:88`)
  takes `history, tools, anchor, counter`.
- The badge facts live laptop-side: `EngineHost.kind/noun` (`engine-host.ts:17,109`),
  the workload `name` (`engine-runtime.ts:591`, `deps.name` in attach),
  `container` (attach: `engine-runtime.ts:716`; `inspect` knows the pod's
  container list, `engine-k8s.ts:199-206`). Pod-supplied text never reaches it
  (the name is the one the laptop created / the user typed).
- A pod/container name is user-typed or laptop-generated, but an attach target
  comes from the CLI argument; it is passed through `untrustedText` (already
  the helper for forged labels, `engine-runtime.ts:752`) before display.

### Design

**Pure view-models (no React), unit-tested** — `packages/tui/src/`:

- `target-view.ts`: `TargetBadge = { engine: "docker"|"podman"|"kubernetes"; name; container? }`;
  `targetText(t)` → `docker tentacle-x`, `pod name`, `pod name/container`
  (`kubernetes` is shown `pod`).
- `status-view.ts` (extended): `contextView(measured, open, window)` →
  `{ used: number|null; approx: boolean }`: measured wins (exact); else the
  open figure (`approx` = not exact); else `null`. `statusTokens` already hides
  `↑↓` until measured (unchanged: `totals: null`).
- `status-line.ts` (pure): `ctxText`, and `modelBorder(model, width)` → the top
  border string `"─".repeat(n) + " model " + "─"`; too long → `…` + tail of the
  model (cut on the LEFT); `width` too small for any model → plain rule.
  `shortCwd` moves here and takes a `max` so the path shrinks first.

**Components only render**: `StatusBar` gets `target?: TargetBadge`, `contextApprox`;
renders the accent badge in a `flexShrink={0}` Box (never truncated) before the
shrinking path; drops the model box. `LineInput`'s wrapper in `App.tsx` replaces
the `round` top border with a `Text` row from `modelBorder` (gray, like the
border) and keeps the bottom border.

**Context at open:**

- `core/model.ts`: `ModelProvider.countTokens?(request): Promise<number | undefined>`
  — exact prompt size WITHOUT generating; `undefined` = this provider cannot.
- `providers`: `AnthropicProvider.countTokens` → `POST {baseURL}/messages/count_tokens`
  with `buildPayload` minus `max_tokens/stream/temperature` → `input_tokens`.
  `OpenAIProvider.countTokens` → llama.cpp: server root = `baseURL` minus a
  trailing `/v1`; `POST {root}/apply-template {messages, tools}` → `prompt`, then
  `POST {root}/tokenize {content: prompt}` → `tokens.length`. Any non-2xx / bad
  shape → `undefined` (a non-llama server answers 404). `RetryingModelProvider`
  forwards it (no retries: a count is best effort).
- `protocol`: `model/countTokens` (daemon → client): params `{ request: WireChatRequest }`,
  result `{ tokens: int ≥ 0 | null }`; `session/context` (client → daemon):
  params `{ sessionId? }`, result `{ used: int ≥ 0, exact: boolean }`. Both in
  `Method` + `RequestSchemas`; `schema:export` regenerated.
- `agent`: `Agent.contextAtOpen(messages, signal?)`: build the request as the
  loop does; `model.countTokens` raced against `CONTEXT_COUNT_TIMEOUT_MS = 2000`
  (and `signal`); a number → `{used, exact:true}`; `undefined`/throw/timeout →
  `{used: estimateUsed(messages, tools, undefined, counter), exact:false}`.
  `Session.contextUsage()` delegates with its history.
- `daemon`: `HostedSession.context()`; `SessionHost.newSessionContext(link)`
  (no session yet: `createAgent(defaultCwd, …)` for a throwaway agent, count
  `startConversation()` — the same factory every daemon already has, so no
  per-daemon wiring); `Connection` handles `session/context`; `ProxyModelProvider`
  gets an optional 3rd ctor arg `countSend` and implements `countTokens` (a
  `MethodNotFound` → `undefined`). `ModelLink` adds `requestModelCountTokens`.
- `client`: `RemoteClient` serves `model/countTokens` (`servingModel` + `servingCall`)
  and exposes `sessionContext(id?)`; `RemoteSession.context()` waits for the id
  like `skills()`.
- `cli`: `serve.ts tunnelFor` passes the count sender; `local-runtime.ts`
  forwards `context()`; `EngineRuntime.target` (badge) set by `startEngineRuntime`
  / `attachEngineRuntime`, passed to `startTui` in `runEngineTui`. `WorkloadState`
  `ready/starting` gain `containers?: number` (k8s `inspect`) so `attach` shows
  `/container` only when the pod has several.
- `tui`: `App` calls `session.context?.()` once per mounted session (mount,
  `/clear`, attach), stores `{used, exact}` in a ref+state, never awaiting in
  render; failure → stays `null` → `ctx –/128k`.

### Files

protocol (`model.ts`, `session.ts`, `methods.ts`, `schema/protocol.json`) →
core (`model.ts`) → providers (`anthropic-provider.ts`, `openai-provider.ts`,
`retry.ts`) → agent (`agent.ts`, `session.ts`) → daemon (`proxy-model.ts`,
`connection.ts`, `session-host.ts`, `hosted-session.ts`) → client
(`remote-client.ts`, `remote-session.ts`) → cli (`serve.ts`, `local-runtime.ts`,
`engine-runtime.ts`, `engine-host.ts`, `engine-k8s.ts`, `main.ts`) → tui
(`target-view.ts`, `status-line.ts`, `status-view.ts`, `StatusBar.tsx`,
`App.tsx`, `run.tsx`).

### Failure modes

- Count endpoint 404/5xx/garbage/slow → estimate (`~`), silently; the 2 s cap
  also bounds a hung tunnel (the race resolves; the dangling request is aborted).
- Old laptop/daemon (no `model/countTokens` / `session/context`): `MethodNotFound`
  → estimate / `ctx –/max`; never an error row.
- Pod lies in a count reply: it only moves a gauge; the value is clamped to an
  int ≥ 0 by the schema; the TUI never uses it for a decision.
- Disconnect mid-count: the request rejects → estimate / `null`; the first
  measured turn replaces it anyway.
- Race with the first prompt: the first measured `usage` wins (`contextView`
  prefers measured), so a late open count can never overwrite it.
- Overlong model / tiny terminal: border degrades to a plain rule; badge never
  truncated but the path shrinks to `…` first.

### Tests

Red first, then green; one mutation per behaviour (below): pure units
(`target-view`, `status-line`, `status-view`), frames via `ink-testing-library`
(badge, border, ctx variants, hidden ↑↓), providers with fake `fetch`
(Anthropic payload/`input_tokens`; llama.cpp two-step; 404 → `undefined`),
agent (`contextAtOpen`: exact, estimate on throw, estimate on timeout),
daemon (`session/context` over a real `Connection`; proxy tunnels the count and
falls back on `MethodNotFound`), client (serves `model/countTokens`), protocol
schema tests.

## Execution

*— claude-sonnet-5-5, 2026-11-05*

Built in the Implementation's order, red first (new modules/methods: red = the
import / method missing; behavioural reds on the assertion where an old
behaviour existed: the `app.test.tsx` F2 and `components.test.tsx` `ctx –`
assertions were changed to the new contract).

1. **tui pure modules** `target-view.ts`, `status-line.ts` (`modelBorder`,
   `shortPath`, `pathBudget`, `contextMeterView`), `status-view.ts`
   (`contextShown`); `StatusBar` (badge, no model, `ctx –/max`, `~`), `App.tsx`
   (top border row from `modelBorder`, `context?()` asked in `watchSession` so
   mount, `/clear`, switch and attach all ask once), `run.tsx`/`index.ts`.
2. **core/providers**: `ModelProvider.countTokens?`; Anthropic
   `/messages/count_tokens`; llama.cpp `/apply-template` → `/tokenize`
   (`add_special:false`); `RetryingModelProvider` forwards.
3. **protocol**: `model/countTokens`, `session/context` (+ fixtures,
   `schema:export`); **no version bump** (additive, `MethodNotFound` handled).
4. **agent/daemon/client/cli**: `Agent.contextUsage` (2 s cap,
   `CONTEXT_COUNT_TIMEOUT_MS`), `Session.contextUsage`, `HostedSession.context`,
   `SessionHost.newSessionContext`, `Connection` handler +
   `requestModelCountTokens`, `ProxyModelProvider.countTokens`; client serves
   `model/countTokens` and exposes `sessionContext`/`RemoteSession.context`;
   cli `serve.ts` passes the count sender, `local-runtime.ts` forwards
   `context()`, `engine-target.ts` + `EngineRuntime.target` → `startTui`.

**Drift from Implementation:**
- `model/countTokens` result uses an OPTIONAL `tokens` (omitted = cannot count),
  not `null`: the repo's wire-hygiene test forbids `null` on the wire.
- The path budget reserves nothing for the auto-accept hint; the hint box
  shrinks 8× faster (`flexShrink={8}`) so it yields first (an 80-column bar
  otherwise cut the ctx meter).
- A path cap of 40 cells (the old `shortCwd` limit) is kept (`MAX_PATH`).
- `WorkloadState` gained `containers?` (k8s `inspect`); the 6 existing
  `engine-k8s.test.ts` expectations were updated.
- The detached-run join path (`attach-run.ts`) types its runtime as
  `LocalRuntime`; the badge rides on it at runtime (it is `attachEngineRuntime`'s
  object), not in the type. Not exercised by a test.

**Mutations** (one per behaviour; reverted, `shasum` identical to before for all
10 files): M1 badge dim → killed (`target-badge` accent test); M2 border cut on
the right → killed; M3 open figure beats measured → killed; M4 no 2 s deadline →
killed (the slow-count test; the other agent tests fail too, from the dangling
`aborted` promise's unhandled rejection — incidental); M5 proxy rethrows
`MethodNotFound` → killed; M6 container named regardless of count → killed;
M7 Anthropic count keeps `stream`/`max_tokens` → killed; M10 llama.cpp tokenizes
with special tokens → killed; M9 App never asks for the context → killed
(2 frame tests). **M8 SURVIVED** (client rethrowing a local count error instead
of omitting `tokens`): the pod's peer returns an opaque error and the daemon
estimates either way, so the boundary result is identical — kept as defence in
depth, not pinned.

**Gate** (run once, foreground): `bunx tsc --noEmit` clean; `bunx biome check .`
clean (646 files); `bun test packages` 4487 pass · 3 skip (the opt-in live-k8s,
live-docker, slow-keepalive tests) · 0 fail.

**Unverified:** the llama.cpp path against a REAL server (`/apply-template`
accepting `tools`, response shape `{prompt}` / `{tokens}`) and Anthropic
`count_tokens` against the live API — only fake-`fetch` tests. Verify: point a
`tentacle` at a llama.cpp server and an Anthropic key and read `ctx` at open
(`ctx … (N/128k)` without `~`). A non-llama OpenAI server 404s and shows `~`.

## Review

*— claude-opus-5-5, 2026-11-05*

**Verdict: REQUEST-CHANGES.** One HIGH (attach and `--resume` show a wrong figure
as exact), three MEDIUM, five LOW. The badge's trust boundary, the key staying
on the laptop and the protocol wiring all hold.

Reviewer `claude-opus-5-5`, executor `claude-sonnet-5-5`: a fresh context and a
different model, same vendor.

### Findings

1. **HIGH: attach and `--resume` count an empty conversation and call it exact.**
   `App.tsx:1404` asks `context()` BEFORE the eager open at `App.tsx:1414`.
   `RemoteSession.context` (`remote-session.ts:582-584`) reads `id` and `opening`
   synchronously, finds both null and sends `session/context` with no `sessionId`.
   A seeded `--resume` (`local-runtime.ts:598`) has no open at all until its first
   send, so the same happens. Real stack (App, RemoteClient, Connection,
   SessionHost), history of 100k tokens:
   ```
   A attach, daemon history=100k  status: /tmp/w · ctx ░░░░░░░░░░ 0% (3/128k)
   A counts asked: [ 3 ]
   B resume, seed=100k  status: /tmp/w · ctx ░░░░░░░░░░ 0% (3/128k)
   B counts asked: [ 3 ]
   ```
   No `~`, 0% on a session that is 78% full, until the first turn. This is the
   case the feature exists for (Context §3, "fresh session, attach"), and it is
   worse than the old `ctx –`. `attach-run.ts:401` opens before mounting, so a
   join should escape this (by reading, not run). The new tests only cover a
   fresh session (`client/test/session-context.test.ts`), and App frame tests use
   a fake `context`. The fix needs both the open-before-count order and an answer
   for an unopened seeded session; add a real-stack test for each.
2. **MEDIUM: the max is cut at 80 columns while the path keeps its room.**
   `pathBudget` (`status-line.ts:53`) reserves nothing for the auto-accept hint,
   so the meter loses its max with a long cwd:
   ```
   80 local:  …ers/someone/projects/deep/nested/folder · ctx █░░░░░░░░░ ~7% (~9…  ⏵⏵ auto-acc…
   80 docker: docker tentacle-ba89d072 · …s/deep/nested/folder · ctx █░░░░░░░░░ ~7% (~9…  ⏵⏵ …
   40 docker: docker tentacle-ba89d072 · …/folder · c…
   ```
   This breaks "ctx ALWAYS with its max" and "the path shrinks first". Execution's
   claim that `flexShrink={8}` (`StatusBar.tsx:141`) makes the hint yield first
   does not hold for these frames. At 40 columns the meter is gone entirely; a
   compact form or dropping the path is the owner's call.
3. **MEDIUM: a badge wider than the terminal breaks the bar's layout.** A
   `flexShrink={0}` box (`StatusBar.tsx:124`) at 40 columns with a long pod name
   gives 2 rows, 42 cells wide, and no path or ctx:
   ```
   |pod a-very-long-pod-name-that-kubernetes ·|
   |does-allow-here/sidecar|
   ```
   The status bar is expected to be one row, and a line past the width wraps in
   a real terminal. "Never truncated" has no defined behaviour past the terminal
   width: the owner must choose, and the layout must stay one row.
4. **MEDIUM: the tunnelled count is never aborted, and the laptop side has no
   cap.** `ProxyModelProvider.countTokens` (`proxy-model.ts:177`) drops
   `request.signal`, so the Implementation's "the dangling request is aborted" is
   false for a pod run. On a hung endpoint the UI still falls back at 2 s, but the
   laptop's fetch stays open and counts in `servingCall`, so `modelIdle` can hold
   a quit up to `QUIT_MODEL_DRAIN_MS` (10 s). By reading; not executed.
5. **LOW: the stale-answer guard is untested.** See Mutation.
6. **LOW: the open figure is stale after `/compact` before any turn.**
   `setContextOpen` is called only from `watchSession`, and `lastTurnTokens` stays
   null until a turn. It matters once F1 is fixed. By reading.
7. **LOW: an in-process fresh count can omit MCP tools.** With MCP not ready,
   `worker.ts` registers the throwaway agent's tools in `pending` and retains that
   registry, so the figure marked exact can lack them until the first turn. By
   reading.
8. **LOW: stale or misplaced comments.** `proxy-model.ts:174` still says
   `tokens: null`. The new docblock at `remote-client.ts:1866` separates
   `onModelStream` from its own doc, and `connection.ts:261` does the same to
   `sessionSkills`. `contextAtOpen`/`contextView` became
   `contextUsage`/`contextShown`, unrecorded in Drift.
9. **LOW: computation in a component, and an untested path.** `linkCells`,
   `tokenText` and `meterCells` (`StatusBar.tsx:85-93`) belong in the pure module
   (§7). The badge on the detached-run join path has no test, as Execution admits.

### Gate

- `bun run check` **fails in this worktree at its typecheck step**, so it
  short-circuits. The errors come from `tsc -p apps/mobile`: outside
  `node_modules` they are `apps/mobile/tsconfig.json` TS6053 (`expo/tsconfig.base`
  not found) and TS5096. The mobile app's dependencies are absent here, so this
  is the environment, not this diff.
- Parts run separately: `bunx tsc --noEmit` clean; `bunx biome check .` clean
  (646 files); `bun test` **4526 pass · 3 skip (opt-in) · 1 fail · 1 error**.
- The fail and error are `apps/mobile/test/rn-websocket.test.ts` (`Cannot find
  module '@tentacle/client'`); `bun test apps/mobile` alone reproduces exactly
  1 fail and 1 error. Same environment cause. Mobile typecheck and that test
  remain unverified here.

### Mutation

One, in the Review's own scope: removed the `sessionRef.current === session` guard
at `App.tsx:1406`. **SURVIVED** (`target-badge` + `app` tests: 114 pass, 0 fail),
hence F5. Reverted; `shasum` identical before and after
(`fc537376c206a66d75297c39d0dae0f8c9c7e8f7`). The executor's M1-M10 were not re-run.

### Premise table

| Premise | Result |
|---|---|
| Context symptom on `main`: `ctx –`, plain `round` input border | TRUE, read from `git show main:` (`StatusBar.tsx:38`, `App.tsx:2653-2660`); not executed, the feature was absent |
| `version.ts:7` is 15, unchanged | TRUE |
| `session/skills` has the optional `sessionId` shape (`protocol/src/skills.ts:39-47`) | TRUE |
| The loop's request is `messages.map(renderForModel)` + tools (`agent.ts:793-803`) | TRUE |
| `estimateUsed` at `context-awareness.ts:88` | TRUE (now line 87) |
| `EngineKind` at `engine-host.ts:17`; attach at `engine-runtime.ts:716` | TRUE |
| `untrustedText` at `engine-runtime.ts:752` | TRUE as a helper (line moved: import 63, use 763) |
| "the dangling request is aborted" | **FALSE for a pod run** (F4) |
| "the first measured usage wins, so a late count can never overwrite it" | TRUE (`contextShown`), but it does not save F1's pre-turn figure |
| "`RemoteSession.context()` waits for the id like `skills()`" | **FALSE in practice**: it does not wait, because nothing is opening yet (F1) |

### Attacks tried

- **Attach/resume through the real stack:** found F1.
- **Real-width frames, 80 and 40 columns:** found F2 and F3. The border is
  correct at both widths: exact width, right-aligned, cut on the left
  (`──── …seek-ai/DeepSeek-V4.1-Flash-1017 ─`).
- **Forged pod reply:** nothing. `peer.ts:449` validates each result against its
  schema, so a non-integer `used` is refused before it reaches render.
- **Key leak in a pod run:** nothing. Only `tokens` crosses to the pod,
  `onModelCountTokens` swallows provider errors (its test uses a secret URL), and
  `tunnelledAgent` gets only the proxy. A pod can ask for counts of its own text,
  the same surface as `model/stream`.
- **Pod-supplied badge text:** nothing. The engine comes from the host, the name
  from the laptop or the user. A multi-container `/container` may come from the
  `default-container` annotation, which the owner asked to show; it is checked
  against `spec.containers` and passed through `untrustedText`.
- **Throwaway agent side effects:** nothing beyond F7. `buildAgent` makes its own
  `BackgroundJobs`, so `jobs.dispose()` cannot kill a live session's jobs.
- **Protocol:** nothing. Both methods are in `Method` and `RequestSchemas`, both
  ends wired. They are requests, not updates, so `UPDATE_CLASS` and
  `client/mapping.ts` do not apply. No bump is correct for an additive pair.
- **Anthropic payload:** nothing. After stripping, only `model`, `messages`,
  `system` and `tools` remain. Not checked against the live API.
- **Prior art:** nothing open on `count_tokens` or `apply-template` in `docs/eval`,
  `docs/fix` or `docs/library-bugs.md`.

### What holds

Accent badge, absent locally; `/container` only with more than one container;
model on the top border, cut on the left; `↑↓` hidden until measured; the count
runs off the render thread with a 2 s user-visible cap and a silent fallback;
`contextShown` prefers the measured figure. Still unverified: llama.cpp and
Anthropic against real servers (Execution's note stands).

### How the executor behaved

Honest on the surviving M8, on the live-server gap and on the untested join path.
But the tests pinned the fresh-session path only, while the Context named attach,
and the 80-column claim in Drift does not match the frames above. Its gate ran
`bun test packages`, not the full `bun test`, which hid the mobile environment
failure.

### Execution — round 2

*— claude-sonnet-5-5, 2026-11-05*

Answers the Review's REQUEST-CHANGES. Red first (behaviour reds shown on the
unfixed code: the HIGH 1 real-stack tests failed with `Received: 3` for a
10 000-char conversation, i.e. the empty-conversation figure the Review found).

- **HIGH 1 (fixed).** `RemoteSession.context()` (`remote-session.ts`): an
  attach not opened yet is opened FIRST (the memoized `open()`), then THAT
  session is counted; a failed attach rejects (no figure). A resumed seeded
  session (no daemon-side session yet) sends its seed: `session/context` gained
  an optional `messages` (counted by `SessionHost.newSessionContext` the way
  `build` would make the session). A plain fresh session is still the fresh
  conversation. Real-stack tests (`client/test/session-context.test.ts`): attach
  to a daemon history, resume from a seed, failed attach. Additive field; no
  version bump. A seeded count is exact (the provider counted the very history
  the first prompt sends); if a live daemon session of that id exists the open
  attaches to it instead (the run/join path, which opens before mounting).
- **MEDIUM 2 (fixed).** The layout moved to the pure `statusLayout`
  (`status-line.ts`): ONE row, ladder when short = path shrinks (to 8) →
  auto-accept hint dropped → `↑ ↓` dropped → meter loses its bar (`compact`);
  the ctx figure WITH its max is always kept. The `flexShrink` approach is gone
  (the components paint exact cells). Frames at 80/40 columns pinned
  (`target-badge.test.tsx`, real `StatusBar`).
- **MEDIUM 3 (orchestrator default, pending the owner).** The bar stays one
  row; the badge is whole unless it plus the separator and the compact meter
  does not fit: then `targetText(target, limit)` cuts the NAME in the middle
  keeping the engine word and `/container` (`pod etcd-shar…master-0/etcd`).
  One place to change: `status-line.ts` (`targetText(input.target, <limit>)`) /
  `target-view.ts`.
- **MEDIUM 4 (fixed).** `ProxyModelProvider.countTokens` passes the request's
  signal to the sender → `Connection.requestModelCountTokens(request, signal)`
  → `$/cancelRequest` reaches the laptop. The laptop side
  (`onModelCountTokens`) is bounded by the same 2 s rule: both sides now use
  the shared `countTokensBounded` (`core/context.ts`, `COUNT_TOKENS_CAP_MS`),
  which also aborts the provider's own signal on the way out. `Agent.contextUsage`
  uses it too (its hand-rolled race is gone). Tests: core helper (cap, abort),
  daemon (signal reaches the sender), client (cancel aborts the laptop
  provider; a hung provider answers `{}` at the cap).
- **LOW 5 (fixed).** Stale-answer guard tested (App: a late answer of the
  session left by `/clear` is dropped).
- **LOW 6 (fixed).** `/compact` asks the context again (`askContext`, shared
  with `watchSession`); tested.
- **LOW 8 (fixed).** `proxy-model.ts` comment, the two misplaced docblocks
  (`remote-client.ts`, `connection.ts`). Drift, recorded now: `contextAtOpen` →
  `contextUsage` and `contextView` → `contextShown`.
- **LOW 9 (partly fixed).** `linkCells`/`tokenText`/`meterCells` are in the
  pure `statusLayout`. NOT done: a test of the badge on the detached-run join
  path (`attach-run.ts` types its runtime as `LocalRuntime`; it carries
  `target` at runtime only).
- **LOW 7 (NOT fixed).** An in-process fresh count may lack MCP tools while MCP
  is still connecting (the throwaway agent's registry is registered into
  `pending`); fixing it needs a "tools complete" signal from `worker.ts`, not a
  one-liner. The figure is exact for what that agent sees; the first turn
  replaces it.

**Environment:** the Review's `tsc -p apps/mobile` emitted untracked `.js` files
into `apps/mobile` (`App.js`, `index.js`, `polyfills.js`, `src/*.js`,
`test/rn-websocket.test.js`); they broke `biome` and were not mine, so I
removed those six untracked, regenerable files. `git status apps` is clean.

**Mutations** (one per item, reverted, `shasum` identical for all 5 files):
HIGH 1 skip-the-open → killed (2 tests); HIGH 1 drop the seed → killed;
MEDIUM 2 room = width → killed (10); MEDIUM 3 no badge limit → killed (3);
MEDIUM 4 no cap (timer inert) → killed; MEDIUM 4 signal not passed → killed;
LOW 5 guard removed → killed; LOW 6 no refresh after `/compact` → killed.

**Gate** (once, foreground): `bunx tsc --noEmit` clean; `bunx biome check .`
clean (647 files); `bun test packages` 4512 pass · 3 skip (opt-in) · 0 fail.
Not run: `tsc -p apps/mobile` and `bun test apps/mobile` (dependencies absent
here, as the Review found). Still unverified: llama.cpp / Anthropic against
real servers.

## Review — round 2

*— claude-opus-5-5, 2026-11-05*

**Verdict: REQUEST-CHANGES.** One MEDIUM remains: finding 3 of round 1 is fixed
for a long pod name but not for a long container name. HIGH 1, MEDIUM 2 and
MEDIUM 4 are fixed and pinned. Four LOWs.

Reviewer `claude-opus-5-5`, executor `claude-sonnet-5-5`: a different model, and
the same reviewer context as round 1, so this pass is not fresh-context.

### Findings

1. **MEDIUM: a long container name still breaks the one-row bar.** `targetText`
   (`target-view.ts`) cuts only the name and always keeps `/container`, so the
   result can exceed `limit`, and the badge sits in a `flexShrink={0}` box
   (`StatusBar.tsx`). Real-width frames with a 63-character container (the
   Kubernetes maximum):
   ```
   40 longcontainer  rows=2 maxw=42 max=NO |pod …/cccccccccccccccccccccccccccccccccc ·|
                                            cccccccccccccccccccccccccccc|
   80 longcontainer  rows=1 maxw=80 max=NO |pod …/ccccccc…ccccccc · ctx ~7%…|
   ```
   At 40 columns the bar is two rows and 42 cells wide with no ctx; at 80 it is one
   row but loses the max. By arithmetic, two rows start at about 32 characters at
   40 columns; only 63 was measured. The tests pin a short `sidecar` and `etcd`
   only. `statusLayout`'s "badge within its limit" needs to hold for every input,
   which means the container must give way too.
2. **LOW: a long link message still costs the max and the badge name.** It is
   transient, shown only while disconnected, with a 61-character message:
   ```
   80 link+pod  |disconnected: connection refused by the remote daemon a…pod … · ctx ~7% (~9k/12…|
   40 link      |disconnected: connection re…ctx ~7% (~9…|
   ```
   `linkCells` (up to 70% of the width) is not traded against the compact meter.
   80 columns with the link alone is fine.
3. **LOW: `--resume` into a pod now sends the history at mount, not at the first
   prompt.** `context()` passes the seed in `session/context` (`remote-session.ts`).
   A `run --resume` that quits without a prompt has already shown the laptop's
   history to the pod, which §7 treats as untrusted. The pod would get the same
   history at the first prompt, so this changes when, not what. By reading the path;
   the local-stack repro confirms the seed reaches the daemon with no session
   created. **Owner's call:** keep this, or use `~` estimated on the laptop.
4. **LOW: round 1's LOW 7 remains (accepted by the executor).** An in-process fresh
   count may lack MCP tools until the first turn. By reading.
5. **LOW: round 1's LOW 9 remains in part.** The detached-run join path's badge has
   no test, and `target` is absent from its type.

### Round 1 findings

| Finding | Result | Evidence |
|---|---|---|
| HIGH 1 attach | **Fixed, pinned** | Real stack: `ctx ████████░░ 78% (100k/128k)`, one count of 100005; was `0% (3/128k)` |
| HIGH 1 `--resume` | **Fixed, pinned** | Same figure, one count, 0 sessions created daemon-side |
| MEDIUM 2 max at 80 | **Fixed, pinned** | `…p/nested/folder · ctx █░░░░░░░░░ ~7% (~9k/128k) ⏵⏵ auto-accept off (shift+tab)`; finding 2 above is the link-only exception |
| MEDIUM 3 wide badge | **Partly fixed** | `pod a-v…ere/sidecar · ctx ~7% (~9k/128k)` at 40 is right; finding 1 above is not |
| MEDIUM 4 abort and cap | **Fixed, pinned** | Hung laptop provider through the real tunnel: estimate at 2003 ms, laptop signal aborted at 2003 ms, `modelIdle` waited 0 ms |
| LOW 5 stale answer | Test present (`target-badge.test.tsx:180`) | Executor's mutation reported killed; not re-run |
| LOW 6 `/compact` | Fixed (`App.tsx:1817`), test at `target-badge.test.tsx:213` | Executor's mutation reported killed; not re-run |
| LOW 7 MCP tools | Not fixed | Finding 4 |
| LOW 8 comments | Fixed | `proxy-model.ts` comment and both docblocks read correct; Drift recorded |
| LOW 9 pure layout, join test | Partly fixed | `statusLayout` is pure; finding 5 |

### Frames (real width, real Ink, `App` and `StatusBar`)

```
80 |──────────────────────────────────── rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 ─|
80 |docker tentacle-ba89d072 · …s/deep/nested/folder · ctx █░░░░░░░░░ ~7% (~9k/128k)|
80 |docker tentacle-ba89d072 · …/folder · ↑54k ↓1.2k · ctx █░░░░░░░░░ ~7% (~9k/128k)|
80 |pod a-very-long-pod-name-th…ernetes-does-allow-here/sidecar · ctx ~7% (~9k/128k)|
40 |──── …seek-ai/DeepSeek-V4.1-Flash-1017 ─|
40 |docker tentac…9d072 · ctx ~7% (~9k/128k)|
40 |…/folder · ctx █░░░░░░░░░ ~7% (~9k/128k)|
40 |pod ppppppp…ppppppp · ctx ~7% (~9k/128k)|
```

### Gate

`bunx tsc --noEmit` clean; `bunx biome check .` clean (647 files); `bun test
packages` **4512 pass · 3 skip (opt-in) · 0 fail**. As asked, `apps/mobile` was
not run.

### Mutation

One: `onModelCountTokens` no longer passes the peer's `signal` to
`countTokensBounded` (`remote-client.ts:1877`). **KILLED** by "a cancelled daemon
request aborts the laptop provider's own signal"
(`client/test/session-context.test.ts:139`): 7 pass, 1 fail. Reverted; `shasum`
identical before and after (`cc40acc93f7c0905f168f183489ffed0068ebc42`).

### Attacks tried

- **Attach opens before `watch`:** `context()` now calls `open()` before the App
  subscribes, against the "watch FIRST" comment. Nothing: both happen in one tick,
  the open is memoized, and `raise` buffers activities until `watch`. A failed
  attach rejects `context()` silently while the App's own `open` reports it.
- **Seed count creates a session:** nothing. 0 sessions listed after the count.
- **Seed against the real build:** nothing. `newSessionContext` and `build` both
  pass the messages to `Session` as they are.
- **Long inputs at both widths:** found findings 1 and 2.
- **Protocol:** nothing. `messages` is an optional addition, so no bump; 15 is
  unchanged. Peer validation of results still stands (round 1).

### Correction to round 1

The executor is right about the stray files: **this reviewer's** round 1 ran
`tsc -p apps/mobile`, directly and through `bun run check`, and that emitted the
`.js` files into `apps/mobile`. Round 1's Review did not report them. `git status
--short apps` is clean now. `bun run check` will do the same in any worktree
without the mobile dependencies, which is worth a separate look.

### How the executor behaved

Accurate on what it left undone (LOW 7, the join test) and on the stray files, and
every round 2 claim checked here held. The gap is one of coverage: the badge rule
was tested for a long name, not for the other part of the same string. Its
`MEDIUM 3` default still awaits the owner.

### Execution — round 3

*— claude-sonnet-5-5, 2026-11-05*

Answers "Review — round 2" (REQUEST-CHANGES: one MEDIUM, four LOWs).

1. **MEDIUM 1 (fixed, owner-confirmed rule).** `targetText(target, limit)`
   (`target-view.ts`): the bar is ALWAYS one row and the result never exceeds
   `limit`; the engine word is always whole. Whole if it fits; else only the NAME
   is cut in the middle with `…`, keeping `/container` whole while the name keeps
   ≥ 5 cells (`pod etcd…er-0/guard`); else `name/container` are cut TOGETHER in
   the middle (`pod etcd-gu…ntainer`). A limit under word + 2 cannot hold a name
   (the word and `…` come back; not reachable above ~20 columns). Pinned: the two
   owner examples (unit + the real `StatusBar` frame
   `pod etcd…er-0/guard · ctx ~7% (~9k/128k)` at 40 columns), a 63-char container
   at 40 and 80 columns (one row, ≤ terminal, ctx max visible), and a property loop
   over engines × name lengths × container lengths × every limit ≥ word + 2.
2. **LOW 2 (fixed).** The link message now gives way FIRST: `statusLayout` sizes
   the badge and the compact meter before the link, which gets only what is left
   (cut with `…`; under 6 cells it is dropped, as is its box). A 61-char message
   at 40 and 80 columns costs neither the ctx max nor the badge name (same badge
   as with no link).
3. **LOW 3 (owner decision, no code change).** KEEP sending the seed with
   `session/context` at mount on `--resume`: the ctx at open is exact. This
   changes WHEN the pod receives the laptop's history (mount, not first prompt),
   not WHAT it receives; §7 treats the pod as untrusted either way, and a pod that
   cannot be trusted with the history at the first prompt cannot be trusted with
   it now. Decision recorded here by the owner's instruction.
4. **LOW 4 (fixed, small).** `SessionHostOptions.toolsReady?: () => boolean`
   (default: complete); `newSessionContext` reads it in the stretch where the
   throwaway agent's tools are listed and, when `false`, returns the provider's
   figure as `exact: false` (`~`). `worker.ts` passes `toolsReady: () => mcpReady`,
   so a fresh in-process count taken while MCP is still connecting shows `~` until
   the first turn measures. Not done: re-counting once MCP finishes (the figure is
   a one-time open figure by design).
5. **LOW 5 (fixed).** `attach-run.ts`: `Joined.runtime` and `JoinDeps.attach` are
   typed `EngineRuntime`, so `target` is in the join path's type. Tests: the
   joined runtime keeps the attach's `target` (`attach-run.test.ts`), and
   `runEngineTui` hands `runtime.target` to `startTui` (`main.test.ts`; this is
   the one place both the run and the join paths go through). The join test was
   red as a typecheck (`target` was not in the type) and is mutation-pinned below.

**Mutations** (one per item, reverted, `shasum` identical for all 5 files):
item 1 name-only cut always (`nameRoom >= MIN-100`) → killed (4 tests); item 2
link not bounded by the room → killed (2); item 4 drop the `exact:false` →
killed; item 5 join drops `target` → killed; item 5 `runEngineTui` drops
`target` → killed. (Item 3 has no code.)

**Gate** (once, foreground): `bunx tsc --noEmit` clean; `bunx biome check .`
clean (647 files); `bun test packages` 4525 pass · 3 skip (opt-in) · 0 fail;
`git status apps` clean. `apps/mobile` not run (dependencies absent here).
Still unverified: llama.cpp / Anthropic against real servers.

## Review — round 3

*— claude-opus-5-5, 2026-11-05*

**Verdict: REQUEST-CHANGES.** MEDIUM 1 is fixed: the owner's badge rule holds on
every frame tried at 30 columns and up. Two new MEDIUMs: wide characters in the
cwd cost the ctx max, and the fix for LOW 2 can hide a disconnect completely.
Four LOWs. Four owner questions, all listed below.

Reviewer `claude-opus-5-5`, executor `claude-sonnet-5-5`: a different model, and
the same reviewer context as rounds 1 and 2, so this pass is not fresh-context.

### Findings

1. **MEDIUM: a double-width cwd still costs the ctx max, at 80 columns.**
   `statusLayout` counts code points (`cells`, `status-line.ts:133`; `shortPath`
   too), while Ink lays out terminal cells, so the left box overflows and the meter
   is what gets truncated. Local session, no badge involved:
   ```
   80 cjk cwd  rows=1 w=79 max=NO |…フォルダの名前/さらに深い場所 · ctx █░░░░░░░░░… ⏵⏵ auto-accept off (shift+tab)|
   40 cjk cwd  rows=1 w=40 max=NO |…さらに深い場所 · ctx █░░░░░░░░░ ~7% (~…|
   ```
   This is round 1's finding 2 for anyone working in such a folder, and it breaks
   "ctx ALWAYS with its max". The bar stays one row, so only the figures are lost.
   `string-width` is already a dependency of this package, and `tool-expand.ts:93`
   records measuring with it, not `.length`, as the owner's rule. `modelBorder`
   counts the same way. Nothing tests a wide character here.
2. **MEDIUM: the link state can vanish, with nothing else saying so.** Round 3
   makes the link give way to the badge as well as to the meter, and under 6 cells
   it is dropped:
   ```
   40 link+owner  |pod etcd…er-0/guard · ctx ~7% (~9k/128k)|
   80 link+c63    |pod etcd-guard-sharedocp419-f84…ccccccccccccccccccccccccccc · ctx ~7% (~9k/128k)|
   ```
   The cause was `disconnected: …` in both frames. LOW 2 asked only that the link not
   cost the meter's max; giving way to the badge name was the executor's choice. By
   arithmetic it drops at 80 columns once the badge passes 53 cells, and at 40 once
   it passes 13, so ordinary pod names hit it at 40. `stoppedNotice`
   (`link-status.ts`) writes no transcript line for a plain `disconnected`, and by
   reading none for `reconnecting`, so the bar is the only place these show. §8
   calls a silent drop a bug. The rule itself is question 1.
3. **LOW: the owner's `≥ 5` boundary is not pinned.** See Mutation.
4. **LOW: the link is painted without the layout's text.** The pure layout computes
   `link` with its `…` and separator, but `StatusBar` paints `link.text` through
   `truncate-end`, which eats the separator: `disconnect…pod etcd-guard-…`,
   `reconnec…docker t-1`. So `plain`'s doc comment ("what the components render")
   is not true for the link, and tests on `plain` cannot see this.
5. **LOW: the scroll hint is cut, though documented "counted, never cut"**
   (`status-line.ts:117`). The badge's limit does not count `suffix`: `↑12 mor…` at
   80, and at 40 the hint is gone and `…` replaces the meter's closing `)`:
   `(~9k/128k…`. The max stays readable.
6. **LOW: "not reachable above ~20 columns" is wrong.** Execution and the
   `target-view.ts` comment say this of the word-and-`…` fallback. It starts below
   29 columns (`docker …` + separator + an 18-cell meter), and the App allows down
   to 20, where the max is lost: `pod … · ctx ~7% (~9…`. The rule is question 2.

### Round 2 findings

| Finding | Result | Evidence |
|---|---|---|
| MEDIUM 1, owner's pod | **Fixed, pinned** | 40: `pod etcd…er-0/guard · ctx ~7% (~9k/128k)`; 80: whole, `pod etcd-guard-sharedocp419-f84rv-master-0/guard · …/folder · ctx ~7% (~9k/128k)` |
| MEDIUM 1, 63-char container | **Fixed, pinned** | 40: `pod etcd-gu…ccccccc · ctx ~7% (~9k/128k)`; 80: `pod etcd-guard-sharedocp419-f84…ccc · ctx ~7% (~9k/128k)`; one row, ≤ width |
| LOW 2, link vs meter | **Fixed, overshoots** | The max survives at 40 and 80; finding 2 is the cost |
| LOW 3, seed at mount | **Owner's decision**, no code | Recorded in Execution; `session/context` still carries the seed |
| LOW 4, MCP tools | **Fixed** | `toolsReady` gives `exact: false` while MCP connects; `worker.ts:106`. By reading plus the executor's reported mutation; `serve.ts` has no late MCP registration |
| LOW 5, join path | **Fixed, pinned** | `attach-run.test.ts:211` and `main.test.ts:937` exist; `Joined.runtime` typed; both mutations reported killed by the executor, not re-run |

### Frames (real width, real Ink)

`App`, last rows, `StatusBar` as in the table above:
```
80 |──────────────────────────────────── rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 ─|
80 |pod etcd-guard-sharedocp419-f84rv-master-0/guard · …/folder · ctx ~7% (~9k/128k)|
80 |pod etcd-guard-sharedocp419-f84…ccccccccccccccccccccccccccc · ctx ~7% (~9k/128k)|
40 |──── …seek-ai/DeepSeek-V4.1-Flash-1017 ─|
40 |pod etcd…er-0/guard · ctx ~7% (~9k/128k)|
40 |pod etcd-gu…ccccccc · ctx ~7% (~9k/128k)|
```

**Sweep through real Ink:** 9090 `StatusBar` frames, every width from 30 to 130,
kubernetes and docker, names of 1, 38 and 253 characters, containers of none, 5, 30
and 63, with tokens, a long link, auto-accept, an unknown fill and a large window.
**0 violations** of one row, ≤ width, ctx max present, engine word whole. All
inputs were ASCII; finding 1 is outside it, and it checks presence, so the hidden
link in finding 2 passes.

### Gate

`bunx tsc --noEmit` clean; `bunx biome check .` clean (647 files); `bun test
packages` **4525 pass · 3 skip (opt-in) · 0 fail**. `apps/mobile` not run.

### Mutation

One: `nameRoom >= MIN_NAME_CELLS` → `nameRoom > MIN_NAME_CELLS`
(`target-view.ts:51`), the owner's exact boundary. **SURVIVED**
(`target-view`, `status-line`, `target-badge` tests: 48 pass, 0 fail), hence
finding 3. Reverted; `shasum` identical before and after
(`e4caed5d9bfa3700d3584d558e70b9ab2b2b6dc4`).

### Attacks tried

- **Owner's rule at every width:** nothing, per the sweep.
- **Wide characters in the cwd:** found finding 1.
- **Long link with a long badge:** found findings 2 and 4.
- **Scroll hint with a long badge:** found finding 5.
- **App minimum of 20 columns:** found finding 6.
- **Other late-MCP daemons:** nothing. Only `worker.ts` registers tools late.

### Owner questions (all of them)

1. **When there is no room, does a disconnect beat the badge name?** Recommended:
   yes. The link keeps at least `disconnected`, the name is cut further, and the
   engine word and ctx max stay. Finding 2 needs this answer.
2. **Under 29 columns the engine word and the ctx max cannot both fit: which
   goes?** Recommended: the whole badge goes and the ctx max stays. The App allows
   down to 20 columns, so this is rare.
3. **Merge with llama.cpp and Anthropic counting verified only against fake
   `fetch`?** Recommended: one manual check against each first (Execution has the
   steps). A wrong response shape would silently show `~` forever.
4. **Open a separate fix for `bun run check` writing `.js` into `apps/mobile`** in
   a worktree without its dependencies (seen in round 1)? Recommended: yes; not this
   branch's scope.

### How the executor behaved

Accurate: every claim on MEDIUM 1, LOW 4 and LOW 5 held, and it reported what it
left out. Two overreaches: it widened LOW 2 into a priority decision without marking
it as one, and it stated the 20-column claim without measuring. Its tests share one
blind spot with the code, ASCII only.

### Execution — round 4

*— claude-sonnet-5-5, 2026-11-05*

Answers "Review — round 3" (REQUEST-CHANGES). Red first: the new tests failed on
the round-3 code (10 reds on the first run; the `≥ 5` boundary test was green on
the old code, as the Review found, and is pinned by mutation below).

1. **MEDIUM 1 (fixed).** New pure `cells.ts` (`cellWidth` = `string-width`,
   grapheme-aware `headCells` / `tailCells` / `middleCells`). `statusLayout`,
   `shortPath`, `modelBorder` and `targetText` measure and cut in terminal CELLS,
   never code points. Tests: unit (`shortPath`, `modelBorder`, `targetText` with
   CJK/emoji), the sweep, and real `StatusBar` frames with CJK/emoji cwd, names
   and link at 40 and 80 columns (one row, ≤ width, ctx max visible).
2. **MEDIUM 2 (owner rule, fixed).** The link beats the badge NAME and is never
   dropped silently: it keeps at least its first word, takes up to 60 % of what
   the meter leaves while the badge still fits, and the badge goes down to
   `pod…`. Owner frames, pinned on real Ink: 40 cols
   `disconnected · pod… · ctx ~7% (~9k/128k)`; 80 cols
   `disconnected: connection refused … · pod etcd-g…ter-0/guard · ctx ~7% (~9k/128k)`
   (the exact cut differs slightly from the owner's sketch: the layout cuts the
   link at 60 % of the room). If the link and even `pod…` do not both fit, the
   badge goes whole and the link gets the room; the link is dropped only when
   under 4 cells remain (a line under ~22 columns).
3. **LOW 3 (fixed).** The `≥ 5` boundary is pinned (5 name cells keep `/abc`
   whole; 4 cut `name/container` together).
4. **LOW 4 (fixed).** `statusLayout` returns the link exactly as painted
   (`link`, with `…` and separator); `StatusBar` paints `layout.link` (no
   `truncate-end`), so `plain` is what is rendered.
5. **LOW 5 (fixed).** The scroll/expand hint is counted before the badge limit
   and is whole or dropped (`layout.suffix`), never cut.
6. **LOW 6 (owner rule, fixed).** Below the width where the engine word + `…`,
   the separator and the compact meter fit, the WHOLE badge goes and the meter
   stays whole. Measured thresholds: `pod` 25 columns, `docker`/`podman` 28
   (`pod…` 4 + 3 + 18; `docker…` 7 + 3 + 18). Round 3's "not reachable above ~20
   columns" claim was wrong and is replaced: the engine-word fallback never
   shows, the badge disappears below those widths. Tested at every width 20–30.
7. **LOW 7 (fixed).** The sweep covers CJK and emoji names, containers, link
   messages and cwds, suffixes, widths 30–130, and asserts "link present ⇒ link
   shown" (its first 8 cells), engine word whole, ctx max present, ≤ width.
8. **CHANGELOG (done).** `[Unreleased]`: Added (target badge; context at open)
   and Changed (model name on the input border).

**Mutations** (one per item, reverted, `shasum` identical for the 4 files):
item 1 `cellWidth` counting code points → killed (6); item 2 link share 0.2 →
killed (2); item 3 `>=`→`>` → killed (1); item 4 paint `link.text` instead of
`layout.link` → killed (4); item 5 suffix always kept → killed (3); item 6
badge shown below the threshold → killed (2); item 7 link never shown → killed
(5). (Item 8 has no code.)

**Gate** (once, foreground): `bunx tsc --noEmit` clean; `bunx biome check .`
clean (648 files); `bun test packages` 4537 pass · 3 skip (opt-in) · 0 fail;
`git status apps` clean. Still unverified: llama.cpp / Anthropic against real
servers.

## Review — round 4

*— claude-opus-5-5, 2026-11-05*

**Verdict: PASS (LOW only).** Both MEDIUMs and all of round 3's LOWs are fixed. Five
new LOWs for a final pass. Five owner questions: three new, two still unanswered from
round 3.

The closest call is finding 1: some emoji in the cwd overflow or garble the row. It
is LOW because it needs those emoji in a folder name and Ink does the same with no
repo code. The owner can overrule that in question 1.

Reviewer `claude-opus-5-5`, executor `claude-sonnet-5-5`: a different model, and the
same reviewer context as rounds 1 to 3, so this pass is not fresh-context.

### Findings (all LOW)

1. **Single-unit and joined emoji in the cwd still break the row, inside Ink.**
   `string-width` is right, but Ink's output grid disagrees with it. A single-unit
   emoji (`✅✨⚡`) lays out as 2 cells and writes as 1, then pads; a joined one
   (`👨‍👩‍👧‍👦`) is split per code point. With no repo code, a 30-cell row:
   ```
   ascii   textWidth=6 rowWidth=30 |abcdef                     END|
   cjk     textWidth=6 rowWidth=30 |日本語                     END|
   astral  textWidth=6 rowWidth=30 |🚀🔥🎉                     END|
   bmp     textWidth=6 rowWidth=33 |✅✨⚡                        END|
   zwj     textWidth=6 rowWidth=11 |👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩END‍👦|
   ```
   In the bar, at 80 columns:
   ```
   emoji cwd (bmp)  w=86      |…✅✨⚡✅✨⚡✅ · ctx █░░░░░░░░░ ~7% (~9k/128k)         ⏵⏵ auto-accept off (shift+tab)|
   emoji cwd (zwj)  max=NO    |…omeone/👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧 ⏵⏵ auto-accept off (shift+tab) 28k)|
   ```
   A row over the width should wrap in a real terminal (not run in one). Names and
   containers cannot reach this, because Kubernetes and Docker names are ASCII; only
   the cwd can, and by mechanism the link text and model name. The executor's "the
   sweep covers emoji" holds only for emoji Ink handles. `docs/library-bugs.md` has
   no entry for it, and it should get one. See question 1.
2. **Below the first word's width the link is a fragment, then nothing.** Under 33
   columns with an 18-cell meter, the first word and the whole meter cannot both fit:
   `d · ctx…` at 22, `disco · ctx…` at 26. At 20 and 21 nothing shows, and at 22 and
   23 some inputs also show nothing (a 19-cell meter, a double-width first
   character). The owner rule does not cover this range. Sweep count of frames with
   no link: 20: 1350, 21: 1350, 22: 630, 23: 90, and none above. See question 2.
3. **The scroll and expand hints beat the badge name.** At 80 columns the owner's pod
   is whole until the user scrolls: `pod etcd-guard-s…rv-master-0/guard · ctx ~7%
   (~9k/128k) · ↑12 more (↓ to follow)`. `expanded` is a lasting mode, so it holds the
   cut: `pod et…d · ctx ~7% (~9k/128k) · expanded` at 40. The path is already gone in
   both, so nothing else is left to give way. Round 3 asked for "whole or dropped"
   only; this priority was the executor's. See question 3.
4. **A newline in the link text gives the bar two rows.** At 80 columns with
   `disconnected: line one\nline two`: `rows=2`. This predates round 4: the old
   `truncate-end` painting also gives 2 rows. `link-status.ts` says a stop reason may
   embed a daemon's message and sanitises it for the transcript (`oneLine`), but
   `linkIndicator` does not for the bar. So a pod could plausibly cause this; the path
   from pod to reason was not traced. An `ESC` is dropped by Ink, so that is not an
   injection, and a tab counts as 0 cells. One `oneLine` call should cover all three.
5. **Double ellipsis.** `cutLink` can append `…` to text already ending in one:
   `reconnecting…… · pod a/…`, seen once in the sweep at 72 columns.

### Round 3 findings

| Finding | Result | Evidence |
|---|---|---|
| MEDIUM 1, cells | **Fixed, pinned** for CJK and surrogate-pair emoji | 80 `…名前とても長い · ctx █░░░░░░░░░ ~7% (~9k/128k)  ⏵⏵ auto-accept off (shift+tab)`; the sweep's astral run has 0 width, ctx or engine violations; other emoji are finding 1 |
| MEDIUM 2, link rule | **Fixed, pinned** | 40 `disconnected · pod… · ctx ~7% (~9k/128k)`; 80 `disconnected: connection refused … · pod etcd-g…ter-0/guard · ctx ~7% (~9k/128k)`; the first word and engine word are always present where they fit |
| LOW 3, `≥ 5` | **Pinned** | Test present; executor's mutation reported killed, not re-run |
| LOW 4, painted link | **Fixed** | Separators intact on every link frame; `StatusBar` paints `layout.link` |
| LOW 5, hint | **Fixed** | Whole or absent on every frame; priority is finding 3 |
| LOW 6, thresholds | **Fixed, pinned** | Measured on real frames: `pod…` from 25, `docker…` from 28; below that `ctx ~7% (~9k/128k)` alone and whole, including `App` at 27 and 20 |
| CHANGELOG | **Present and accurate** | Added and Changed under `[Unreleased]`; each claim checked against this review |

### Frames (real width, real Ink)

`App`, last rows:
```
80 |──────────────────────────────── rits/プロジェクト名前とても長い/DeepSeek-V4.1 ─|
80 |pod etcd-guard-sharedocp419-f84rv-master-0/guard · …も長い · ctx ~7% (~9k/128k)|
40 |──── …クト名前とても長い/DeepSeek-V4.1 ─|
40 |pod etcd…er-0/guard · ctx ~7% (~9k/128k)|
27 |ctx ~7% (~9k/128k)|
20 |ctx ~7% (~9k/128k)|
```
`StatusBar`, widths 25 to 34 (a selection):
```
25 |pod… · ctx ~7% (~9k/128k)|              27 |ctx ~7% (~9k/128k)|  (docker)
28 |docker… · ctx ~7% (~9k/128k)|           30 |docker t… · ctx ~7% (~9k/128k)|
33 |disconnected · ctx ~7% (~9k/128k)|      34 |disconnected… · ctx ~7% (~9k/128k)|
```

**Sweep through real Ink:** 116,640 combinations per run: every width from 20 to 34
in full, and one in five at widths up to 129. Kubernetes and Docker; 5 names, 5
containers, 3 cwds, 4 links (none, long, short, CJK), 6 modes. Thresholds are computed
from the real meter. Results, one run each, CJK in all of them:

| Emoji class | One row | ≤ width | ctx whole | Engine word, first word |
|---|---|---|---|---|
| surrogate pair (`🚀🔥🎉😀`) | 0 violations | 0 | 0 | 0 |
| single unit (`✅✨⚡`) | 0 | **fails**, 127 with an ASCII target | 0 | 0 |
| joined (`👨‍👩‍👧‍👦`) | 0 | 0 | **fails**, 52 with an ASCII target | 0 |

Flags and `❤️`-style sequences were not swept on their own; flags were in the first,
mixed run. Row widths are measured with `string-width`, not in a real terminal.

### Gate

`bunx tsc --noEmit` clean; `bunx biome check .` clean (648 files); `bun test packages`
**4537 pass · 3 skip (opt-in) · 0 fail**. `git status apps` clean. `apps/mobile` not
run. Live llama.cpp and Anthropic remain unverified.

### Mutation

One: removed the first-word floor, `Math.max(linkMin, …)` in `statusLayout`
(`status-line.ts`), the owner's "link keeps ≥ its first word". **KILLED** by 3 tests
(two `statusLayout`, one real frame at 40 columns): 57 pass, 3 fail. Reverted; `shasum`
identical before and after (`3a3d97119b8d40a660df144717698bb1c9228b04`).

### Attacks tried

- **Emoji by class, against Ink alone:** found finding 1, and that its cause is
  upstream.
- **Widths 20 to 34 with and without a link:** LOW 6 holds; found finding 2.
- **Control characters in the link:** found finding 4. `ESC` does not reach the
  terminal, in either the old or the new painting.
- **Scroll and expand against a long badge:** found finding 3.
- **Owner's pod with a link, a hint, a CJK path and a CJK model:** nothing beyond
  the above; one row and the max at 80 and 40.

### Owner questions (all of them)

1. **Accept Ink's limit on single-unit and joined emoji in the cwd?** Recommended:
   yes, and register it in `docs/library-bugs.md`. It takes such emoji in a folder
   name. The alternative is to replace them in the shown path, which adds code for a
   rare case.
2. **Under 33 columns the first word and the whole meter cannot both fit: what shows?**
   Recommended: keep the meter whole and accept the fragment, since these widths are
   rare. At 20 to 23 the disconnect stays invisible unless you want a one-cell marker.
3. **Should a scroll or `expanded` hint cut the badge name?** Recommended: no. The name
   comes first, and the hint shows only if it fits whole, which follows "whole unless
   it does not fit".
4. **Merge with llama.cpp and Anthropic counting verified only against fake `fetch`?**
   Asked in round 3, no answer recorded. Recommended: one manual check against each
   first.
5. **Open a separate fix for `bun run check` writing `.js` into `apps/mobile`?** Asked in
   round 3, no answer recorded, and not in `TODO.md`. Recommended: yes, outside this
   branch.

### How the executor behaved

Accurate: its thresholds, frames and its bound on the dropped link all held to within
a column or two. It gave the link's cut a reason where it differs from the owner's
sketch. Two gaps: "the sweep covers emoji" was true only for the emoji class that
works, and the hint's priority over the name was again a decision it did not mark as
one.

### Execution — final pass

*— claude-sonnet-5-5, 2026-11-05*

Answers "Review — round 4" (PASS, 5 LOWs) and the owner's live feedback of 2026-11-05.
The two "Review — final pass: Not OK, absent" notes (written while no executor ran) are
deleted. **Drift from Implementation:** the badge format below replaces `pod <name>` /
`docker <name>` everywhere in Context/Implementation/rounds 1–4 (those texts are history).

1. **LOW 1 (owner: accept Ink's limit).** `docs/library-bugs.md` has an entry (Ink output
   grid vs `string-width`, single-unit and ZWJ emoji, the review's repro frame); the
   comment in `cells.ts` points to it. No workaround.
2. **LOW 2 (owner: accept).** Under ~33 columns the meter stays whole and the link is a
   fragment, no one-cell marker. No code change; pinned in `status-line.test.ts`
   (widths 20–32: meter whole, ≤ width, no `· ·`; 20 → `ctx ~7% (~9k/128k)`, 22 →
   `d · ctx …`, 26 → `disco · ctx …`, 33 → `disconnected · ctx …`).
3. **LOW 3 (owner rule).** The scroll hint and `expanded` never cut the badge name:
   `statusLayout` lays the row out, and if the hint is in it while the badge is cut or
   gone, it lays the row out again without the hint. Owner frames (real Ink, scrolled
   and expanded alike): 80 `kubernetes:etcd-guard-sharedocp419-f84rv-master-0/guard ·
   ctx ~7% (~9k/128k)`; 40 `k8s:etcd…er-0/guard · ctx ~7% (~9k/128k)`.
4. **LOW 4.** `statusLayout` runs the link text through `oneLine` (`commands.ts`, the one
   `link-status.ts` uses): a newline/tab never makes a second row. Tested pure and on a
   real frame at 40 and 80.
5. **LOW 5.** `cutLink` no longer appends `…` to a head that already ends in one.
   Tested over widths 20–120, with and without a badge (no `……`, no `… …`).
6. **Live feedback, new format.** `<engine>:<name>`, no space. Pure `target-view.ts`:
   `targetParts` returns `{prefix, name}`; `kubernetes:` when the whole badge fits, else
   `k8s:`, then the existing cut rule (prefix whole; pod name first while it keeps ≥ 5
   cells, else name/container together). `StatusBar` paints the prefix (colon included)
   `dimColor` and the name `accentHex`. Kubernetes ALWAYS shows `/container`:
   `kubeEngineHost.inspect` returns `inUse` (the `--container`, else the annotation's,
   else the pod's only container; replaces `containers`), `run` uses
   `host.defaultContainer` (`agent`). All laptop-side from the pod read, sanitised by
   `engineTarget`; the exec target is unchanged. **Thresholds recomputed:** the whole
   badge goes below `k8s:…` (5) + 3 + 18 = **26** columns (`docker:…` 8 → **29**,
   `podman:…` 29). Side effect worth knowing: with a link at 40 columns `k8s:…` no
   longer fits beside the first word (`disconnected · k8s:… · ctx …` is 41), so the badge
   goes and the link gets the room (`disconnected: conn… · ctx ~7% (~9k/128k)`); at 41
   the badge is back. Colour split asserted in non-stripped frames (`\e[2mkubernetes:\e[22m`,
   accent `\e[38;2;6;182;212m` on the name; `k8s:` the same).
7. **Live feedback, auto-accept colour.** `autoAcceptHex = "#fec20a"` in `theme.ts` next to
   `accentHex`, used by `StatusBar`; `off` stays dim. Pinned in a non-stripped frame.
8. **CHANGELOG.** Added text rewritten for the new format; Changed: the auto-accept colour,
   one-row link text, no doubled `…`.

**Mutations** (one per item, reverted; `shasum` of the 6 touched sources identical before
and after): 3 wrapper does not re-lay-out → killed (5); 4 no `oneLine` → killed (2);
5 always append `…` → killed (1); 6a `k8s:` short prefix off → killed (20); 6b prefix
painted accent → killed (2); 7 hint back to `accentHex` → killed (1); container only for
a multi-container pod (`inUse` undefined for one container) → killed (3). Items 1–2 have
no behaviour change (2 is a pin).

**Gate** (once, foreground): `bunx tsc --noEmit` clean; `bunx biome check .` clean (648
files); `bun test packages` 4553 pass · 3 skip (opt-in) · 0 fail.

**Live check for the owner (not verified by this pass):**
- Badge per engine, at 40 and 80 columns: `kubernetes:<pod>/<container>` (one-container pod
  too, and a pod you `run`: `/agent`), `docker:<name>`, `podman:<name>`; prefix grey, name cyan.
- Long names: 80 `kubernetes:…` whole, 40 `k8s:etcd…er-0/guard`; under 26 columns the badge
  disappears and `ctx` stays.
- Disconnect (kill the daemon / drop the network): the link text in the bar, one row; at 40
  columns the badge gives way to the link.
- Scroll up and `expanded` with the long pod: the badge name is never cut (the hint is absent).
- `⏵⏵ auto-accept on` golden yellow, `off` grey.
- ctx exact at open on `attach` and on `--resume`, and after `/compact`.
- Real count against llama.cpp (`/apply-template` + `/tokenize`) and Anthropic
  (`count_tokens`): only fake `fetch` so far.

## Review — final pass

*— claude-opus-5-5, 2026-11-05*

**OK: items 1-7 hold,** and the diff touches only the 18 listed files. Same reviewer context, not fresh.
- **Frames, real Ink.** 80: `kubernetes:etcd-guard-sharedocp419-f84rv-master-0/guard · ctx ~7% (~9k/128k)`, scrolled and expanded alike; `docker:t-1 · … · ↑12 more (↓ to follow)`. 40: `k8s:etcd…er-0/guard · ctx ~7% (~9k/128k)`; `disconnected: conn… · ctx ~7% (~9k/128k)`.
- **Under 33 columns.** Fragment as answered: `d · ctx…` at 22, `disco · ctx…` at 26. Badge from 26 (`k8s:…`) and 29 (`docker:…`).
- **Colours, raw frames.** Prefix `\e[2m` with its colon, name `\e[38;2;6;182;212m`; auto-accept on `\e[38;2;254;194;10m`, off dim.
- **Sweep.** 75,600 frames, widths 20-130, ASCII, CJK and surrogate-pair emoji, newline links: 0 violations of one row, ≤ width, ctx whole, prefix, first word, hint whole, no name cut beside a hint, no `……`. Accepted emoji classes excluded.
- **Mutation.** `run` drops `host.defaultContainer` from the badge: killed (89 pass, 1 fail); `shasum` identical (`418f3d85…`).
- **Gate.** `bunx tsc --noEmit` clean; `bunx biome check .` clean (648 files); `bun test packages` 4553 pass · 3 skip · 0 fail.

**LOW, for the owner to know.** With a link at 40, `k8s:…` no longer fits (41 cells), so the badge goes: disclosed in Execution, and it differs from round 4's frame. `docs/library-bugs.md` says only user-controlled text reaches the Ink limit, but a link message can embed a daemon's text. Live engines and real count endpoints remain unverified.
