# eval/proxy-model-cancel — cancel (Esc) does not interrupt the in-flight model call on the pod path (`--model-proxy`)

> **Status:** eval (Context + Review; Implementation empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes (touches the agent loop + the model reverse-tunnel §7 invariant + a protocol addition); mandatory fresh-context Review. If promoted → `docs/fix/proxy-model-cancel.md`.

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** on the pod reverse-tunnel path
(`--model-proxy`), does `session/cancel` actually stop the in-flight model call
— on the daemon (agent loop) and on the laptop (the real provider)? If not, is
it worth a `fix`, and in what shape that keeps the protocol additive (v1)?

**Evidence (source, verified).**

- `packages/daemon/src/proxy-model.ts:50-55` — `ProxyModelProvider.stream`
  ignores `request.signal`: it `await`s the whole `model/stream` RPC
  (`this.send(...)`) and only then yields the batch.
- `packages/daemon/src/connection.ts:90-93` — `requestModelStream` is a plain
  `peer.request(Method.ModelStream, { request })`; no signal, no cancel.
- `packages/client/src/remote-client.ts:165-174` — `onModelStream` runs the
  laptop provider as `this.modelProvider.stream(params.request)`; the wire
  request carries no signal and none is created, so the laptop provider can
  never be aborted.
- `packages/protocol/src/methods.ts:33,40,60,66` — the only cancel is the
  `session/cancel` notification; nothing cancels a `model/stream` request.
  `packages/protocol/src/model.ts:54` — `ModelStreamParamsSchema` is
  `.strict()` (relevant to the fix, see Review).
- How cancel arrives: TUI Esc/Ctrl+C → `abortRef.current.abort()`
  (`packages/tui/src/App.tsx:625,652`) → `RemoteSession.send` `onAbort` →
  `client.cancel(id)` → `session/cancel` (`packages/client/src/remote-session.ts:53`,
  `remote-client.ts:138-140`) → `HostedSession.cancel()` aborts the turn
  controller (`packages/daemon/src/hosted-session.ts:130-132`). That part
  works. The signal reaches the agent's `ChatRequest` (`packages/agent/src/agent.ts:208`),
  but the proxy provider drops it.
- **Worse, in the agent loop:** the cancel is only checked at the top of an
  iteration (`agent.ts:193`) and in the stream `catch` (`agent.ts:237`). If the
  stream *completes normally* after the abort (which is all the proxy can do),
  then (a) with no tool calls the turn ends **`end_turn`** with the full reply
  kept in history (`agent.ts:244-279`), and (b) with tool calls, **the tools
  run** (`agent.ts:282-300`): there is no `signal.aborted` check between the
  end of the stream and tool execution.
- The TUI stays "running" the whole time: it consumes `session.send` until the
  daemon's `session/prompt` resolves (`App.tsx:350`, `remote-session.ts:56-66`).

**Repro (in-process, no repo change).** Script:
`/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/proxy-cancel/repro.ts`.
It follows the `packages/cli/test/model-proxy.test.ts` pattern: `createChannelPair`,
`SessionHost` + `Connection` (daemon), `RemoteClient` (laptop) with a slow fake
model (30 text deltas over 3 s, honours `request.signal`), optionally one
`probe` tool call (`permission: "allow"`). The client sends a prompt, aborts at
300 ms, and measures until `turn_end`. "direct" = the same slow model given to
the daemon agent directly (control); "proxy" = `ProxyModelProvider` → laptop.
Run: `bun <script>` from the repo root. Actual output:

```
{"path":"direct","withTool":false,"cancelAtMs":300,"turnEndMs":304,"reason":"cancelled","textEvents":3,"laptopModelSawSignal":true,"laptopModelCompletedAtMs":-1,"toolRanAfterCancel":false}
{"path":"proxy","withTool":false,"cancelAtMs":300,"turnEndMs":3035,"reason":"end_turn","textEvents":30,"laptopModelSawSignal":false,"laptopModelCompletedAtMs":3034,"toolRanAfterCancel":false}
{"path":"direct","withTool":true,"cancelAtMs":300,"turnEndMs":303,"reason":"cancelled","textEvents":3,"laptopModelSawSignal":true,"laptopModelCompletedAtMs":-1,"toolRanAfterCancel":false}
{"path":"proxy","withTool":true,"cancelAtMs":300,"turnEndMs":3034,"reason":"cancelled","textEvents":30,"otherEvents":["tool_start","tool_result","turn_end"],"laptopModelSawSignal":false,"laptopModelCompletedAtMs":3032,"toolRanAfterCancel":true}
```

(some fields trimmed). Control path: cancel lands in ~4 ms. Proxy path: the
turn ends only when the laptop model finishes (~3 s, i.e. the whole
generation), the laptop provider never sees a signal, the text-only turn
reports `end_turn` (not `cancelled`), and **the tool the model asked for runs
after the user cancelled**.

**Veracity verdict: CONFIRMED**, and broader than claimed. The claim (proxy
ignores the signal, no cancel on the wire, loop blocked until the laptop
finishes, laptop keeps generating) holds exactly. Not in the claim: after the
late reply arrives, the cancelled turn can still run tools (and, for `ask`-level
tools, a permission prompt would appear after Esc), and a text-only cancelled
turn is recorded as a normal `end_turn`.

**Severity: high** for the pod path. Cancel is the user's only brake; on a
local model, a reply takes minutes, and the turn then acts on tools the user
tried to stop. On the direct paths (in-process worker, `connect` without the
proxy) cancel works; this is pod `run`/`exec` with `--model-proxy` only.

**Trigger:** any Esc/Ctrl+C while a `model/stream` request is in flight on
`--model-proxy` (`packages/cli/src/serve.ts:66-90`). The magnitude is the whole
remaining generation time. Tools run when the reply has tool calls.

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-17*

**Verdict: promote to `fix/proxy-model-cancel`.** The bug is real and was
reproduced. The tools-run-after-cancel part makes it a correctness/safety
issue, not only a matter of waiting.

**Fix direction (three layers, the first is independent of the wire):**

1. **Agent loop (defence in depth, `packages/agent/src/agent.ts`).** After the
   `model.stream` loop returns, check `signal?.aborted` and emit
   `turn_end: cancelled` *before* pushing the assistant message or running any
   tool (and in the max-iterations final turn). This closes the tool-run hole
   for *any* provider that finishes after an abort, not just the proxy. Small,
   and testable with a provider that ignores the signal.
2. **Daemon proxy (`proxy-model.ts`).** Race `send(...)` against
   `request.signal`: on abort, throw an `AbortError` right away, so the
   agent's existing `catch` (`agent.ts:237`) ends the turn as `cancelled` within
   milliseconds, and send a cancel to the laptop (layer 3). A late RPC result
   is then dropped.
3. **Protocol + laptop (additive, version stays 1, AGENTS §7).** Add a new
   notification (e.g. `model/cancel { streamId }`) wired on both ends. The
   client keeps an `AbortController` per in-flight `model/stream` and passes its
   signal into the local provider's `ChatRequest`, so the laptop stops
   generating tokens. **Gotcha:** `ModelStreamParamsSchema` is `.strict()`
   (`protocol/src/model.ts:54`). Adding an optional `streamId` to
   `model/stream` params makes an *old* laptop reject the request as
   `InvalidParams`. In practice the laptop and the pod binary are shipped
   together, but the fix must decide this explicitly: either key the cancel on
   something old peers already accept (e.g. the JSON-RPC request id exposed by
   the peer), or accept the skew and document it. An old client that gets the
   unknown notification only logs it (`transport/peer.ts:239-241`), with no harm.
   Don't serialize the peer: the cancel is a notification handled concurrently
   (§7).

**Failure modes the fix must cover:** cancel before the RPC is sent (the
signal is already aborted, so don't send); a cancel that races the result (the
result arrives after the abort, so drop it, and the turn stays `cancelled`); the
laptop provider ignores its signal (layers 1–2 still end the daemon turn at
once); disconnect while the request is in flight (the existing peer close path
rejects pending requests); history after a cancelled turn (no half
assistant/tool-call pair left orphaned).

**Tests (red first, §9):** reuse the `model-proxy.test.ts` harness with a slow
fake laptop model. Assert (a) `turn_end` is `cancelled` within a small bound
after abort, (b) the laptop provider received an aborted signal, (c) a
proposed tool is **not** executed after cancel. (c) also needs an agent-level
unit test with a signal-ignoring provider. Check non-vacuity by removing the
post-stream `aborted` check.

Not verified here: the real pod/k8s run (the repro is in-process over
`createChannelPair`, the same transport the existing F4.d test uses), and a real
OpenAI-compatible laptop provider's abort behaviour (only a fake that honours
the signal was used).
