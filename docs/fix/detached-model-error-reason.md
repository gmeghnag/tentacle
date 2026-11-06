# fix/detached-model-error-reason — A model HTTP error names its cause where the user looks

> **Status:** executed, awaiting Review
> **Branch:** `fix/detached-model-error-reason` (not opened — plan only)
> **Size:** S · **Blast:** cross-module · **Suited:** Sonnet may execute (one function + tests); Review standard in-context plus one explicit red-team of the §7 pod-trust invariant (the text sent to the pod). The change sits on the pod-trust redaction path, so a fresh-context Review is recommended even though the diff is small.

Type: fix · Size: S · Blast: cross-module · Suited: Sonnet + fresh-context Review of the redaction.

## Context

*— claude-sonnet-5-5, 2026-11-06*

**Problem.** In `run`/`attach` (and `run --detach`) the model lives on the laptop and the daemon in the pod reaches it through `model/stream` / `model/streamChunked`. When the laptop's provider answers an HTTP error, the user sees only `internal error`. The laptop knows the cause and does not say it where the user looks. Found live 2026-11-05 (a 401 from a config with no API key), diagnosed by reading in feat/config-carry round 2.

**Path, re-verified on current main (49f4584).** The TODO line numbers have drifted; these are the current ones.
1. `packages/providers/src/openai-provider.ts:38-51` — `ModelRequestError(status, body, hint?, retryAfterMs?)`, `name = "ModelRequestError"`. The `message` carries `body.slice(0,200)` and the hint, so it can hold the endpoint or key material. Thrown at `openai-provider.ts:192`, `anthropic-provider.ts:134,238,249,264`. The retry layer retries 429/500/502/503/529 and rethrows the last one as a `ModelRequestError` (`retry.ts:13-17,126-129`); every other status (401, 403, 404, 400, 504) passes through untouched.
2. `packages/client/src/remote-client.ts:2106-2111` (`onModelStreamChunked` catch) and `:1944` (`model/stream`) do `throw this.connectionLost(error) ?? error`. `connectionLost` (`:1957-1984`) returns an `RpcError` only for `ModelConnectionError` / `ModelUnreachableError` with an `E…` code. A `ModelRequestError` returns `null`, so it is rethrown as is.
3. `packages/transport/src/peer.ts:361-376` — a non-`RpcError` handler throw goes to `reportError` (laptop `onError`) and the peer answers the pod `InternalError`, message `"internal error"`, unless `exposeInternalErrors` (it is not set on the laptop's client-side peer). An `RpcError` keeps its `code`/`message`.
4. `packages/daemon/src/hosted-session.ts:247-256` (`redactTurnError`) — the daemon turns the model-call failure into `turn_end.error` with the text it received. With `exposeTurnErrors` unset it is `"internal error"`. For an `RpcError` (the `connectionLost` case) the text passes through.
5. `packages/client/src/remote-session.ts:1346-1355` (`end`) — the attached TUI and the relay both get `RpcError(code, client.laptopText(outcome.error.message))`.
6. `packages/cli/src/relay.ts:366-380` — the relay's `drive` catches that throw and emits `turn_failed{message: untrustedText(error.message)}`. `relay-state.ts:110,170-172` makes it `state: failed` + `detail`. `relay.log` and `tentacle ps` both read that detail.
7. The real error goes only to the run's `daemon.log`: `engine-runtime.ts:1041` (`onPeerError` → `stderr.onStderr("[laptop rpc] …")`), fed by `peer.reportError` (`peer.ts:362`). Verified: the comment at `engine-runtime.ts:1040-1041` says "a model/turn error is not a failure of the attach (the TUI showed it)", which is false for a pod run: the TUI does not show it either.

**Where the user looks, and what each shows today** (by reading the path above; nothing run yet, see Repro):

| Where | 401 / 404 | 429 / 5xx (after retries) | network error (reset, refused, timeout) |
|---|---|---|---|
| `relay.log` `state: failed …`, and `tentacle ps` (same `detail`) | `internal error` | `internal error` | named: `model connection lost …` / `could not connect to the model endpoint (ECONNREFUSED)`; connect timeout shows the full laptop text via `laptopText` |
| attached TUI to a pod / container / detached run | `internal error` | `internal error` | named (as above) |
| in-process worker TUI (`tentacle` with no engine) | the real message (`worker.ts:110` `exposeTurnErrors: true`; the model is local, so this is trusted) | the real message | the real message |
| `daemon.log` of the run (`[laptop rpc] …`) | full error | full error | full error |

So the gap is exactly "an HTTP error answered by the model" on a **pod-hosted** run (`run`, `run --detach`, `attach`). The in-process worker does not share it: there the agent runs next to the model and `redactTurnError` is told to expose. Out of scope but noted: `connect` to a remote `serve` (model on the daemon host, `exposeTurnErrors` unset, `serve.ts:182,456` only logs) shows `internal error` too; there the user owns the daemon host and its log, a different trust model and a different task.

**Constraint (AGENTS §7).** The pod is not trusted. A provider message can carry the endpoint or key, so nothing derived from the message text may cross to the pod. The pod may get a text built from the HTTP status only, as `connectionLost` already does for connection errors from `code` and `phase` only.

**Repro** (to run in the executor's first step, in `.tentacle/tmp/detached-model-error-reason/`; not yet run, the table above is by reading): copy the existing end-to-end pattern from `packages/client/test/remote.test.ts:284-330` (a `RemoteClient` + `Connection` pair over `createChannelPair`, the local model a stub) with the stub throwing `Object.assign(new Error("model request failed with status 401: key sk-X at http://10.0.0.5"), {name: "ModelRequestError", status: 401})`. Expected today: `failure === "internal error"`. This is the red.

## Implementation

*— claude-sonnet-5-5, 2026-11-06*

### Load-bearing assumption

The text the laptop's `RemoteClient` puts in an `RpcError` is the only thing that crosses to the pod, and it is the same text the laptop's own session (TUI and relay) gets back as `turn_end.error`. So one status-only text, built in `RemoteClient`, fixes the pod's turn error, the relay's `failed` detail, `tentacle ps` and the attached TUI at once, with no new channel.
Proof: the pod never sees the original error; `peer.ts:365-376` and `connectionLost`'s `RpcError` are the only outputs; `remote-session.ts:1346-1355` hands the same message to the laptop session; the existing end-to-end test (`remote.test.ts:284`, `expect(failure).toContain("model connection lost mid-stream (ECONNRESET)")`) already shows a `connectionLost` text reaching `session.send` on the laptop.

### Preconditions

- Reuse the `connectionLost` seam (`remote-client.ts:1957`), already used at both model-call sites (`:1944`, `:2111`). No new path, no new protocol field, no `PROTOCOL_VERSION` bump (an `RpcError` text on an existing error is a display change; the wire shape is unchanged).
- `ModelRequestError` is identified by `name` and a numeric `status`, like the existing duck-typing on `ModelConnectionError` (the client package does not import providers' classes there; keep that).
- `onError` still receives the full error, so `daemon.log` keeps the body (§7 persistence/log: laptop side only).
- The single-broker, no-serialization and persistence invariants are not touched.

### Design

In `connectionLost` (rename to `modelCallFailed` optional; keep the name to keep the diff small), add a second arm:

- `error.name === "ModelRequestError"` and `Number.isInteger(status)` and `100 <= status <= 599` → call `this.onError?.(error)`, return `new RpcError(InternalError, text)` with `text = "the model endpoint answered ${status}"`. Built from the integer only. Optional reason phrase from a fixed table keyed by status (401 `unauthorized`, 403 `forbidden`, 404 `not found`, 429 `rate limited`, 5xx `server error`) — written by us, never from the response. Recommended: include the table for 401/403/404/429 only, because "answered 401" alone makes the user look up the code; see Owner question 1.
- Any other `status` (the Anthropic stream `error` event uses `status 0`, `anthropic-provider.ts:238`) → text `the model endpoint reported an error` (no number, no body).
- Everything else keeps today's behaviour (`null`, opaque).

No `laptopTexts` swap is needed: the status text already is the full laptop text. (The hint tentacle writes, such as "set `apiKey`", is not provider text, but it is concatenated into `message`; extracting it would have to be separate from `body`. Not done; Owner question 2.)

The comment at `engine-runtime.ts:1040-1041` ("the TUI showed it") is corrected to say the failure's cause now reaches the TUI as the status text and the full error is in this log. Comment only.

### Files

1. `packages/client/src/remote-client.ts` — extend `connectionLost` (about +15 lines) and update its doc comment and the two catch comments at `:2106-2110` that say "opaque" for everything non-connection.
2. `packages/cli/src/engine-runtime.ts:1040-1041` — comment fix.
3. Tests (below): `packages/client/test/remote.test.ts` (end to end, the pattern at `:284`); `packages/cli/test/relay.test.ts` (or the existing relay test file) for the `failed` detail — find the file with `grep -n "turn_failed" packages/cli/test/*.ts` first and match its fake runtime.
4. `CHANGELOG.md` line; `TODO.md` entry marked done at merge.

No protocol, daemon, transport or tui change.

### Failure modes

- **401, 403, 404:** `the model endpoint answered 401 (unauthorized)` in relay.log / `ps` / the TUI; the pod's turn error is the same text. Converges: the turn ends `error`, history keeps the prompt (same as the connection-lost case).
- **429 / 5xx after retries (`retry.ts`):** the exhausted retryable status surfaces as its own `ModelRequestError` (`retry.ts:17`), so it gets the same arm. `retry-after` is not shown.
- **Non-numeric, missing or out-of-range `status`** (a malformed duck-type, `status` as a string, `NaN`): no number is interpolated, so a hostile or odd value cannot smuggle text. Only an integer in 100–599 is printed; anything else gets the number-free text.
- **A provider error whose message holds a key** (the test uses `sk-X` and an endpoint): neither appears in the pod's text, the relay detail, nor the TUI; only in `onError`.
- **Cancel / abort:** unchanged (`remote-client.ts:2098-2102` runs first and throws "model stream cancelled").
- **Title call (`purpose: "title"`) failing:** goes through `model/stream` (`:1944`); gets the text too. The title path swallows its failure daemon-side (unchanged). Verify in the test run that nothing new surfaces in the TUI for a failed title.
- **Version skew:** none; the message is a string in an existing error.
- **Old pod with a new laptop / new pod with an old laptop:** an old laptop answers opaque as before; nothing breaks.
- **Hint lost:** the user no longer sees "set apiKey" that the local worker shows. Accepted (the status is the point); see Owner question 2.

### Tests

All red-first on current main (a mutation each follows). Use the existing fakes: `createChannelPair`, `SessionHost`, `ProxyModelProvider`, `Connection`, `RemoteClient` as at `remote.test.ts:284-330`; for the relay, the existing fake `attach` dep (`relay.ts` takes `deps.attach`) and `finalView`.

1. **Status text reaches the laptop session, secrets do not reach the pod** (`remote.test.ts`, end to end). Stub model throws a `ModelRequestError`-named error, `status: 401`, message `…key sk-X at http://10.0.0.5…`. Assert `failure` equals/contains `the model endpoint answered 401`; capture the frames the daemon side received (wrap the daemon channel or read the daemon's `turn_end.error` from the session history, as the neighbouring test reads `session.snapshot()`) and assert none contains `sk-X` or `10.0.0.5`. Red now: `"internal error"`. Mutation: remove the new arm → fails; mutation 2: put `error.message` in the text → the secrets assertion fails (this is the non-vacuity of the §7 half).
2. **Table over statuses** (`test.each`): 401, 403, 404, 429, 500, 503, 529 → text contains the number; 0 (Anthropic stream error) → `reported an error`, no digits from the body; `status: "401"` (string), `NaN`, `99`, `600` → the number-free text; an unrelated `Error("x")` → still `internal error`. Mutation: widen the range check → the 99/600 rows fail.
3. **`onError` still gets the full error** (laptop log keeps the cause): same setup, `onError` spy receives the original error with the body. Mutation: drop the `this.onError?.(error)` → fails.
4. **`model/streamChunked` and `model/stream` both** covered: run test 1 for both call sites (the chunked one is the default for `run`; `:1944` is the unchunked fallback/title). Mutation: change only one site → the other row fails.
5. **Relay detail** (`packages/cli/test`): the relay with a fake runtime whose `session.send` throws `RpcError(…, "the model endpoint answered 401")` ends `state: failed`, `detail` containing it; guards that `untrustedText` does not eat it. Likely already true by construction; keep it as a thin contract test and say so in Execution if it is green on main (it would then not be red, and is labelled as a guard, not the regression test).
6. **Non-regression:** the existing `ModelConnectionError` / `ModelUnreachableError` tests (`remote.test.ts:284-330,553`) stay green.

Validation: `bun test packages/client/test/remote.test.ts` per slice; full `bun run check` before done (lint baseline clean, §6). Manual (unverified part): a real `run --detach` with no apiKey shows `state: failed … answered 401` in `relay.log` and `tentacle ps` — verify with the original live repro.

## Execution

*— claude-sonnet-5-5, 2026-11-06*

Re-verified after feat/parallel-agents: `connectionLost` is in `remote-client.ts` (both call sites `onModelStream` / `onModelStreamChunked`); the plan holds, no design drift. Red: new `describe` at the end of `packages/client/test/remote.test.ts`; on unfixed code every row gave `Received: "internal error"` (assertion red, not a compile error).

As built: `connectionLost` gets a first arm for `name === "ModelRequestError"` → `modelRequestFailed(error, status)` (calls `onError` with the full error; text from an integer status 100–599 plus the `MODEL_STATUS_REASON` table 401/403/404/429; otherwise `the model endpoint reported an error`). Comment fix in `engine-runtime.ts` (container attach site). CHANGELOG Fixed line.

Redaction: tests assert that no frame the laptop sent, and not the pod's history, contains the fake key `sk-LEAKED-KEY` or `10.0.0.5`; `onError` keeps them. Mutation: appending `error.message` to the text made the status 0/"401"/NaN/99/600 rows fail; reverted.

Drift: plan test 5 (relay detail guard) not added: `relay.ts` forwards the RpcError message unchanged, covered by the end-to-end `session.send` text. Unverified: a live `run --detach` with no apiKey.

## Review

**Verdict: PASS (LOW-only).** Reviewer is the same model family as the executor (claude-sonnet-5-5, fresh context): shared blind spots survive; the task is cross-module, not load-bearing, but sits on the §7 pod-trust path.

**Gate (narrow, once):** `bunx tsc --noEmit` clean · `bunx biome check .` 666 files, no fixes · `bun test packages/client packages/cli packages/transport` 2036 pass / 0 fail (110 files). Full `bun run check` not re-run.

**Mutation (one):** removed `this.onError?.(error)` in `modelRequestFailed` → `a 401 names its cause…` FAILS (95 pass / 1 fail); restored; `shasum` of `remote-client.ts` equals the pre-mutation `d4946c42…`, tree clean. (Process slip: my `cp` backup failed, so I restored by hand-editing the same line; the shasum proves it is byte-identical.)

**Premise table:** `connectionLost` returns null for ModelRequestError today and rethrows (`remote-client.ts` catch sites) TRUE · `peer.ts` answers non-RpcError as "internal error" TRUE (per Execution red: every row gave "internal error") · `laptopText` swap only touches texts in `laptopTexts`; the new text is not registered, so it passes unchanged TRUE · `engine-runtime.ts` comment was false, now corrected TRUE.

**Attacks tried:**
1. *Provider text in the pod text:* text = integer status (100–599, `typeof number` + `isInteger`) + our own 4-entry table; `error.message`/body/URL/header never read. Boxed `Number`, string, NaN, float, 0, 99, 600 all fall to the number-free text (tests cover them). Nothing found.
2. *Spoofing / subclass:* the duck-type is `instanceof Error` + `name === "ModelRequestError"`. A subclass with another name, or a plain Error with a `status` field and another name, stays opaque ("internal error"). A plain Error that sets `name` falls into the status-only arm, which prints nothing but the integer. Only the laptop's own provider can throw it, the pod cannot trigger it. Nothing found.
3. *Streaming vs non-streaming:* both `onModelStream` and `onModelStreamChunked` end in `throw this.connectionLost(error) ?? error`; both tested (`requestModelStream` and a full turn). `countTokens`/`slots` swallow errors by design (bounded helpers), nothing crosses.
4. *`onError` sinks:* `modelRequestFailed` sends the full error to the laptop `onError` only: `onPeerError` → run `daemon.log` via `stderr.onStderr` in `engine-runtime.ts` (laptop file), `connect` sink prints locally. No pod-side sink found. Nothing found.
5. *Visibility:* the same `RpcError` text is what `remote-session` hands back (`laptopText` is identity for it), so relay `turn_failed` → `state: failed … answered 401 (unauthorized)`, `ps` and the attached TUI show it; the relay detail is covered only transitively (plan test 5 dropped, see finding 2).
6. *Retry layer:* exhausted 429/5xx surface as `ModelRequestError` (`retry.ts:17`) and get the arm. Nothing found.

**Findings (all LOW):**
1. `remote-client.ts` `modelRequestFailed`: `onError` fires for every title-call failure too (`purpose: "title"`), adding a `daemon.log` line the title path previously did not produce. Log noise only; the pod and TUI see nothing new from a failed title (daemon swallows it). Verify live, not blocking.
2. Execution dropped plan test 5 (relay `failed` detail) as "covered by the end-to-end send text". True by construction (`relay.ts` forwards the message through `untrustedText`), but `untrustedText` on a text containing `(` / digits is not pinned by any test. A one-row guard in the relay test would close it. Optional.
3. The `ModelRequestError` arm sits inside `connectionLost`, whose doc comment (above it) still says "any other error, left to the peer's opaque default" and describes only connection loss. Doc nit; rename to `modelCallFailed` was optional in the plan.
4. Unverified, as the Execution says: a live `run --detach` with no apiKey. The Repro was written to run on main but the red is documented only in Execution prose, not pasted.

**Questions (recommendation):** none for the owner. Decisions 1–3 as the orchestrator set them are implemented as stated.

**What holds:** the redaction is by construction (no message read), the §7 half is pinned by tests asserting the secret and host are absent from every frame the laptop sent and from the pod history, and the `onError` half is non-vacuous (my mutation). **Executor behaviour:** stayed in scope, small diff, honest about the dropped test and the unverified live part.

## Owner questions

1. Should the text include a fixed reason word (`the model endpoint answered 401 (unauthorized)`) or the number alone? **Recommend the word** for 401/403/404/429 only (our own table, never the response). Other statuses show the number.
2. Should the laptop also show tentacle's own hint (such as "set `apiKey`")? **Recommend no, in this task**: it needs the hint separated from the provider body in `ModelRequestError` (a providers change, wider blast); log-only today. Open a follow-up if wanted.
3. The same gap on `connect` to a remote `serve` (model on the daemon host) is left out. **Recommend** a separate small task only if you use `connect` with remote models.

### Orchestrator decisions (owner delegation 2026-11-06)

1. Reason word for 401/403/404/429 from our own table (recommendation).
2. No apiKey hint in this task (recommendation); follow-up only if wanted.
3. `connect` left out (recommendation).
Start after feat/parallel-agents merges (shared `packages/client/src/remote-client.ts`).

### Orchestrator live check + decisions (2026-11-06, owner delegation)

Binary = main + this branch (gate 4871 pass, 3 skip, 0 fail), installed. `run --detach --engine docker` with a config copy whose top `model` block has no `apiKey` (owner's local endpoint answers 401): `relay.log` now ends `state: failed the model endpoint answered 401 (unauthorized)` (before: `failed internal error`). Review LOWs (title-log noise, no relay-level test) accepted as is — cosmetic / covered at the client boundary. Merged under the owner's one-night delegation.
