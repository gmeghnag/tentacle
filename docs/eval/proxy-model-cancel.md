# eval/proxy-model-cancel — a cancelled turn can still run tools (agent loop has no post-stream / between-tools abort check)

> **Status:** eval (Context + Review; Implementation empty until promoted). **Re-verified 2026-10-19** on `main` after [`../fix/pod-model-streaming.md`](../fix/pod-model-streaming.md): the *model* half is fixed on the real (chunked) pod path. What remains is the **agent-loop** half, which is provider-independent, plus a low-priority batch-fallback gap. If promoted → `docs/fix/proxy-model-cancel.md`.
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval → fix · **Size:** S (agent loop only; was M before pod-model-streaming) · **Blast:** load-bearing (the agent loop) · **Suited:** strong model executes; mandatory fresh-context Review.

## Context

### Re-verification on current `main` (what is still open)

*— claude-opus-5-5, 2026-10-19*

**The question being decided (narrowed):** after a user cancel (Esc /
`session/cancel`), can the agent loop still push the assistant reply and run
tools? If yes, fix it in the loop, for every provider and runtime.

**What changed since 2026-10-17.** `fix/pod-model-streaming` made the real pod
path chunked (`model/streamChunked`), and that path honours the abort. The
`ProxyModelProvider` forwards the caller's signal into a per-call `tunnel`
controller (`packages/daemon/src/proxy-model.ts:199`), and the peer sends
`$/cancelRequest` to the laptop (`packages/transport/src/peer.ts:52`), which
aborts the laptop provider. `serve.ts` wires both senders
(`packages/cli/src/serve.ts:63-104`). Layers 2 and 3 of the original fix
direction are therefore **done** for the chunked path. Layer 3 was built as
`$/cancelRequest`, not the `model/cancel` notification proposed below.

**What is still open (verified with the repro below):**

1. **No abort check after the stream ends normally.** In
   `packages/agent/src/agent.ts`, cancel is checked at the top of an iteration
   (:193) and in the stream `catch` (:237). If `model.stream` *completes*
   after the abort, the loop pushes the assistant message (:244) and runs the
   tool calls (:283). This happens with any provider that does not throw on
   abort: the batch fallback, a third-party provider, or the window where Esc
   lands just after the last event. Scenarios `batch` and `ignore` below show
   tool #1 running about 2.7 s after the cancel.
2. **No abort check between tool calls in one round (new).** The
   `for (const call of toolCalls)` loop (`agent.ts:283`) never checks
   `signal.aborted`. A cancel that lands while tool #1 runs does not stop tool
   #2. It still starts unless every tool honours `ctx.signal` and nothing in
   between does. Scenario `twoTools` shows tool #2 starting at 607 ms after a
   cancel at 300 ms. With `ask`-level tools, that also means a permission
   prompt can appear *after* Esc.
3. **Batch fallback ignores the signal** (`proxy-model.ts:181`,
   `await this.send(wire)`). This only matters for an old laptop talking to a
   new pod (mixed-version). It is low priority: points 1–2 contain the
   damage, and the remaining cost is waiting for the laptop's generation to
   finish.

**Repro (2026-10-19, `main` @ `69be6be`).** Run it from
`.tentacle/tmp/proxy-model-cancel/` with `bun repro.ts`. It uses the in-process
`createChannelPair` → `SessionHost`/`Connection` (daemon) ↔ `RemoteClient`
(laptop) stack, the same one as `packages/cli/test/model-proxy.test.ts`. Cancel
fires at 300 ms. Scenarios:
- `chunked`: real pod wiring, both senders.
- `batch`: old-laptop fallback.
- `ignore`: no proxy; the daemon's model ignores its signal and completes
  after about 3 s with one tool call.
- `twoTools`: no proxy; the model finishes at about 200 ms with two tool calls,
  and tool #1 takes 400 ms while ignoring its signal.

```ts
// Does Esc (session cancel) stop the turn, and does any tool run after it?
// Scenarios (in-process: createChannelPair + SessionHost/Connection + RemoteClient):
//   chunked  — the real pod path (ProxyModelProvider with both senders, as serve.ts wires it)
//   batch    — the old-laptop fallback (batch sender only)
//   ignore   — no proxy; the daemon's model ignores its signal and completes normally
//   twoTools — no proxy; the model honours abort but ends before the cancel with 2 tool
//              calls; the cancel lands during tool #1 (which ignores its signal)
import { z } from "../../../node_modules/.bun/zod@3.23.8/node_modules/zod/lib/index.js";
import { Agent } from "../../../packages/agent/src/index.ts";
import { RemoteClient } from "../../../packages/client/src/index.ts";
import { PermissionBroker } from "../../../packages/core/src/index.ts";
import { Connection, ProxyModelProvider, SessionHost } from "../../../packages/daemon/src/index.ts";
import { ToolRegistry } from "../../../packages/tools/src/index.ts";
import { createChannelPair } from "../../../packages/transport/src/index.ts";

type Scenario = "chunked" | "batch" | "ignore" | "twoTools";
const CANCEL_AT = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(scenario: Scenario) {
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  let modelSawAbort = false;
  let modelDoneAt = -1;
  const toolsRan: string[] = [];
  const honours = scenario !== "ignore";
  const calls =
    scenario === "twoTools"
      ? [
          { id: "c1", name: "probe", arguments: '{"n":1}' },
          { id: "c2", name: "probe", arguments: '{"n":2}' },
        ]
      : [{ id: "c1", name: "probe", arguments: '{"n":1}' }];
  let called = false;
  const model = {
    id: "slow",
    async *stream(req: { signal?: AbortSignal }) {
      req.signal?.addEventListener("abort", () => {
        modelSawAbort = true;
      });
      const steps = scenario === "twoTools" ? 2 : 30; // twoTools: done at ~200 ms, before the cancel
      for (let i = 0; i < steps; i++) {
        if (honours && req.signal?.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        await sleep(100);
        yield { type: "text", delta: "." };
      }
      modelDoneAt = ms();
      if (!called) {
        called = true;
        for (const toolCall of calls) yield { type: "tool_call", toolCall };
      }
      yield { type: "done" };
    },
  } as never;

  const tools = new ToolRegistry();
  tools.register({
    name: "probe",
    description: "p",
    inputSchema: z.object({ n: z.number() }),
    permission: "allow",
    async execute(input: { n: number }) {
      toolsRan.push(`#${input.n}@${ms()}ms`);
      if (scenario === "twoTools") await sleep(400); // ignores its signal
      return { content: "ok" };
    },
  } as never);

  const [d, c] = createChannelPair();
  let connection: Connection | undefined;
  const proxied = scenario === "chunked" || scenario === "batch";
  const proxy = new ProxyModelProvider(
    (r) => (connection as Connection).requestModelStream(r),
    scenario === "chunked"
      ? (r, h) => (connection as Connection).requestModelStreamChunked(r, h)
      : undefined,
  );
  const env = {
    id: "n",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: async () => "",
    writeFile: async () => {},
  } as never;
  const host = new SessionHost({
    defaultCwd: "/w",
    createAgent: () => ({
      agent: new Agent({ model: proxied ? proxy : model, tools, env }),
      permissions: new PermissionBroker(),
    }),
  });
  connection = new Connection(d, host);
  const client = new RemoteClient(c, new PermissionBroker(), proxied ? model : undefined);
  await client.initialize();
  const session = client.newSession();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), CANCEL_AT);
  let reason: string | undefined;
  let turnEndMs = -1;
  for await (const ev of session.send("hi", ac.signal) as AsyncIterable<{
    type: string;
    reason?: string;
  }>) {
    if (ev.type === "turn_end") {
      reason = ev.reason;
      turnEndMs = ms();
    }
  }
  await sleep(500); // let any straggling tool finish
  console.log(
    JSON.stringify({
      scenario,
      cancelAtMs: CANCEL_AT,
      turnEndMs,
      reason,
      modelSawAbort,
      modelCompletedAtMs: modelDoneAt,
      toolsRan,
    }),
  );
  connection.close();
  client.close();
}

for (const s of ["chunked", "batch", "ignore", "twoTools"] as const) await run(s);
process.exit(0);
```

Output:

```
{"scenario":"chunked","cancelAtMs":300,"turnEndMs":305,"reason":"cancelled","modelSawAbort":true,"modelCompletedAtMs":-1,"toolsRan":[]}
{"scenario":"batch","cancelAtMs":300,"turnEndMs":3039,"reason":"cancelled","modelSawAbort":false,"modelCompletedAtMs":3032,"toolsRan":["#1@3039ms"]}
{"scenario":"ignore","cancelAtMs":300,"turnEndMs":3035,"reason":"cancelled","modelSawAbort":true,"modelCompletedAtMs":3033,"toolsRan":["#1@3035ms"]}
{"scenario":"twoTools","cancelAtMs":300,"turnEndMs":1009,"reason":"cancelled","modelSawAbort":true,"modelCompletedAtMs":205,"toolsRan":["#1@205ms","#2@607ms"]}
```

How to read it:
- **`chunked`**: fixed. The turn ends 5 ms after the cancel, the laptop model
  sees the abort, and no tool runs.
- **`batch` / `ignore`**: point 1. The model completes and **tool #1 runs
  after the cancel**. The turn still reports `cancelled`, because the loop
  catches the abort at the top of the *next* iteration (:193), after the tool
  has already run.
  - With a text-only reply, the same paths report `end_turn` and keep the
    reply in history. That is what the 2026-10-17 repro below shows, and it
    reproduced the same way on 2026-10-19 with that script.
- **`twoTools`**: point 2. Tool #2 starts 307 ms after the cancel.

**Severity:** still high. Cancel is the user's only brake, and what leaks
through is *actions* (tool runs, possibly permission prompts), not just
latency. On the default local and pod paths, a well-behaved provider plus a
signal-honouring tool hides point 1, but point 2 needs only one tool that is
slow to react.

### Original finding (2026-10-17, kept for history; line numbers are as of that date)

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** on the pod reverse-tunnel path
(`--model-proxy`), does `session/cancel` actually stop the in-flight model call
— on the daemon (agent loop) and on the laptop (the real provider)? If not, is
it worth a `fix`, and in what shape that keeps the protocol additive (v1)?

**Evidence (source, verified then).**

- `packages/daemon/src/proxy-model.ts:50-55` — `ProxyModelProvider.stream`
  ignored `request.signal`: it `await`ed the whole `model/stream` RPC and only
  then yielded the batch. *(Now: still true for the batch fallback only,
  `:181`.)*
- `packages/daemon/src/connection.ts:90-93` — `requestModelStream` was a plain
  `peer.request`, with no signal and no cancel. *(Now: the chunked sender takes
  `signal`.)*
- `packages/client/src/remote-client.ts:165-174` — `onModelStream` ran the
  laptop provider with no signal. *(Now: the chunked handler gets the request's
  `signal`, aborted by `$/cancelRequest`.)*
- How cancel arrives: TUI Esc/Ctrl+C → `abortRef.current.abort()` →
  `RemoteSession.send` `onAbort` → `client.cancel(id)` → `session/cancel` →
  `HostedSession.cancel()` aborts the turn controller. That part worked then
  and still works.
- **In the agent loop:** the cancel is only checked at the top of an iteration
  and in the stream `catch`. If the stream *completes normally* after the
  abort, (a) with no tool calls, the turn ends `end_turn` with the full reply
  kept in history, and (b) with tool calls, **the tools run**. *(Still true,
  see the re-verification.)*

**Repro (then):** the same in-process stack with the batch-only
`ProxyModelProvider`. The script lived in an ephemeral session scratchpad and
was not pasted, so it is superseded by the script above. Output:

```
{"path":"direct","withTool":false,"cancelAtMs":300,"turnEndMs":304,"reason":"cancelled","textEvents":3,"laptopModelSawSignal":true,"laptopModelCompletedAtMs":-1,"toolRanAfterCancel":false}
{"path":"proxy","withTool":false,"cancelAtMs":300,"turnEndMs":3035,"reason":"end_turn","textEvents":30,"laptopModelSawSignal":false,"laptopModelCompletedAtMs":3034,"toolRanAfterCancel":false}
{"path":"direct","withTool":true,"cancelAtMs":300,"turnEndMs":303,"reason":"cancelled","textEvents":3,"laptopModelSawSignal":true,"laptopModelCompletedAtMs":-1,"toolRanAfterCancel":false}
{"path":"proxy","withTool":true,"cancelAtMs":300,"turnEndMs":3034,"reason":"cancelled","textEvents":30,"otherEvents":["tool_start","tool_result","turn_end"],"laptopModelSawSignal":false,"laptopModelCompletedAtMs":3032,"toolRanAfterCancel":true}
```

**Veracity verdict then: CONFIRMED**, and broader than the original claim (tools
run after cancel; a text-only cancelled turn is recorded as `end_turn`).

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-19 (supersedes the 2026-10-17 review)*

**Verdict: promote to `fix/proxy-model-cancel`, scoped to the agent loop (S,
load-bearing).** The proxy and protocol layers are done (chunked path,
`$/cancelRequest`). The slug is kept for continuity even though the remaining
fix is not proxy-specific.

**Fix direction (`packages/agent/src/agent.ts` only):**
1. **After the stream loop returns** (after the `catch` at :237, before
   `messages.push` at :244): if `signal?.aborted`, emit
   `turn_end: cancelled` and return. Do not push the late assistant reply and
   do not run its tools. That also fixes the text-only `end_turn`
   misreport.
2. **Before each tool call** in `for (const call of toolCalls)` (:283): if
   `signal?.aborted`, stop. The remaining calls must not start.
   - **History-validity catch:** an assistant message with `toolCalls` whose
     later calls have no `tool` result is a dangling pair (the class in
     `docs/eval/history-validity-invariant.md`).
   - Either push a synthetic `tool` result for every skipped call (e.g.
     "cancelled by the user before it ran"), or don't push the assistant
     message's unexecuted calls at all.
   - Synthetic results are the simpler choice, and the history stays valid.
     Decide in Implementation and pin it with a test.
3. **The max-iterations final turn** (:309) already checks `!signal?.aborted`
   before starting. Re-check after its stream for symmetry.
4. **Out of scope (separate, low priority):** making the batch fallback
   (`proxy-model.ts:181`) race the signal. Points 1–2 already stop the actions
   there; only the wait remains.

**Failure modes to cover:**
- abort arrives after the last event but before tools;
- abort during tool #k of N;
- a tool that ignores `ctx.signal` (the loop must still stop the rest);
- `ask`-level tools (no permission prompt after cancel);
- the persisted history after a cancelled round must be valid (no orphan
  `toolCalls`), and `--resume` must work on it;
- sub-agents (`agent_task`) get the same loop, so a cancelled child must not
  run further tools either.

**Tests (red first, §9):** agent-level unit tests in `packages/agent/test/`
with (a) a provider that ignores its signal and returns a tool call, and (b) a
provider that returns two tool calls, where tool #1 is slow and ignores its
signal while the test aborts during it.
- Assert: no tool after abort, `turn_end: cancelled`, and valid history.
- Show both tests red on current `main` (the repro above is the evidence they
  will be).
- Non-vacuity: remove each new check in turn and confirm its test fails.

**Not verified:** a real pod/k8s run (the repro is in-process over
`createChannelPair`), and a real OpenAI-compatible provider's behaviour in the
"abort just after the last SSE event" window.
