# fix/proxy-model-cancel — a cancelled turn can still run tools (agent loop has no post-stream / between-tools abort check)

> **Status:** merged to main (2026-10-19) — Implementation approved, Execution + **three** adversarial fresh-context Reviews complete (round 1 **APPROVE-WITH-NITS**; round 2 cross-model **APPROVE-WITH-NITS**; round 3 **APPROVE-WITH-NITS**) — every finding across all three rounds is **resolved** (loop checks 1–4 + the `runTool` post-permission abort re-check, each pinned by a non-vacuous red-first test; index nits fixed). The *model* half was fixed on the real (chunked) pod path by [`pod-model-streaming.md`](pod-model-streaming.md). What this fix closed is the **agent-loop** half, which is provider-independent, plus (out of scope, now its own TODO item) the low-priority batch-fallback gap.
> **Branch:** `fix/proxy-model-cancel`
> **Type:** fix · **Size:** S (agent loop only; was M before pod-model-streaming) · **Blast:** load-bearing (the agent loop) · **Suited:** strong model executes; mandatory fresh-context Review.

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

*— Qwen3.8-27B-Q6, 2026-10-19*

### Load-bearing assumption

**The agent loop is the single choke point for every provider and runtime.**
Every runtime (in-process worker, pod `run`/`attach`, remote `connect`) drives
the turn through the same `Agent.runMessages` (AGENTS §7: one session path), and
every `ModelProvider` — a well-behaved one, a batch-fallback
`ProxyModelProvider`, or a third-party one that swallows its signal — funnels
through the same `for await (const event of this.config.model.stream(request))`
body at `packages/agent/src/agent.ts:220-233`. So an abort check placed at the
loop's own boundaries (after the stream body returns, before each tool call)
stops the leak for **all** providers without touching any of them.

Proven, not assumed: the repro in Context (`ignore` and `twoTools` scenarios)
runs a model that ignores its signal through exactly this loop and shows the
damage; the `chunked` scenario shows that when the provider *does* honour the
signal, the existing `catch` at `agent.ts:236-241` already produces a clean
`turn_end: cancelled` — so the loop-boundary checks are the missing half, and
they must not disturb that working path.

### Preconditions (verified on current `main`)

1. Existing abort checks: top of iteration `agent.ts:193-196`; stream
   `catch` `agent.ts:236-241`; pre-final-turn `agent.ts:309`;
   final-turn `catch` `agent.ts:343-346`. The gaps are the post-stream
   *success* path (no check before `messages.push` at `:244`) and the tool
   loop (`for (const call of toolCalls)` at `:283`, no check per call).
2. The assistant message is pushed **before** its tools run
   (`agent.ts:244-248`), so a between-tools abort leaves the already-pushed
   `toolCalls` unanswered unless the loop answers them (synthetic results).
   This is the same dangling-pair class as
   [`history-validity-invariant.md`](../eval/history-validity-invariant.md)
   (its row D shows abort-mid-tool is currently *safe* because the loop keeps
   running; our change deliberately stops early, so it must stay safe).
3. `Session.send` persists in `finally` after the generator settles
   (`packages/agent/src/session.ts:69-75`), so whatever is in `messages` when
   the loop returns is exactly what gets written — the synthetic results are
   persisted and `--resume` replays a valid history.
4. History well-formedness only needs a `tool` message per `tool_call` id
   (`packages/core/src/model.ts:26-35`: `toolCallId` links the result;
   `toolCalls` on the assistant carries the ids). A synthetic
   `{ role: "tool", content, toolCallId }` with `isError`-flavoured content is
   valid and honest.
5. A `tool_result` without a preceding `tool_start` is already tolerated on
   every consumer: the TUI state reducer creates the item on demand
   (`packages/tui/src/state.ts:218-233`, `idx >= 0 ? ... : {...}`); the daemon
   maps it to a plain `tool_call_update`
   (`packages/daemon/src/mapping.ts:82-88`); the client mapping is a field
   copy (`packages/client/src/mapping.ts:100-...`). So emitting a
   synthetic-result `tool_result` for a skipped call is safe even though no
   `tool_start` was emitted for it.
6. Sub-agents get the same signal: `createTaskTool` passes `ctx.signal` into
   the runner (`packages/tools/src/task.ts:60-63`), and the runner feeds it to
   the child's `run` (`packages/agent/src/subagent.ts:175-179`). The child
   runs the same `runMessages`, so the loop fix covers it automatically.
   (`toolContext.signal` is built from the turn signal at `agent.ts:180-186`.)
7. The `max_iterations` final turn offers no tools (`agent.ts:312-342`), so no
   between-tools check exists there; only a post-stream check is needed.

### Design

Three additions to `packages/agent/src/agent.ts`, all at loop boundaries, all
gated on `signal?.aborted` (a `turn` with no signal is unaffected):

1. **Post-stream check** — between the stream `try/catch` (`agent.ts:219-241`)
   and the `messages.push` of the assistant message (`agent.ts:244`): if
   `signal?.aborted`, end the turn `cancelled` **without** pushing the late
   assistant reply. (The `catch` at `:236-241` already handles the throwing
   provider; this handles the one that *completes* after the abort.) This
   fixes the text-only `end_turn` misreport at the same time: a cancelled
   turn no longer keeps a full reply in history.
2. **Between-tools check** — at the top of `for (const call of toolCalls)`
   (`agent.ts:283`): if `signal?.aborted`, do **not** start this call; instead
   answer it with a synthetic result so history stays valid (precondition 2):
   push `{ role: "tool", content: CANCELLED_TOOL_NOTE, toolCallId: call.id }`
   and `yield { type: "tool_result", id: call.id, name: call.name, result:
   { content: CANCELLED_TOOL_NOTE, isError: true } }`, then continue to the
   next call (which hits the same check). No `tool_start` is emitted for a
   skipped call (it never ran); consumers tolerate the orphan
   `tool_result` (precondition 5). `CANCELLED_TOOL_NOTE` is a module-level
   constant (style of `CONTINUE_NUDGE`, `agent.ts:44`), e.g.
   `"Cancelled by the user before this tool ran."`.
   - The check must also sit **after** a real tool completes and **before**
     the next one starts — i.e. the loop-top check is exactly that, because
     the body of the iteration is one call.
   - `ask`-level tools: `gate.authorize` is only reached inside `runTool`,
     which is never called for a skipped call → no permission prompt after
     Esc.
3. **Max-iterations symmetry** — after the final tools-less stream
   (`agent.ts:314-338`): if `signal?.aborted`, end `cancelled` instead of
   falling to `max_iterations`. The existing `catch` (`:343-346`) covers the
   throwing case; this covers the completing case (mirrors point 1).

**Decision (from the eval's open item):** synthetic `tool` results for
skipped calls (option A), not dropping the unexecuted `toolCalls` from the
assistant message (option B). A: history stays valid without mutating an
already-pushed message, the model (on a later resumed turn) sees that the
calls were cancelled rather than silently missing, and it is a smaller diff.
Pinned by a test.

**What the turn looks like after the fix** (from Context's repro, expected):
- `ignore`: `turn_end: cancelled` at ≈300 ms, no tools run, no assistant
  reply pushed (the model's late completion is discarded).
- `twoTools`: tool #1 runs (already started), tool #2 gets a synthetic
  `tool_result` (no `tool_start`, no execution), turn ends `cancelled`.
- `batch`: same as `ignore` for the turn outcome — the *wait* for the laptop
  to finish is unchanged (out of scope, see below).
- `chunked`: unchanged (already correct).

### Files

| File | Change |
|---|---|
| `packages/agent/src/agent.ts` | the three loop-boundary checks above + `CANCELLED_TOOL_NOTE` constant. ~15 lines. |
| `packages/agent/test/agent.test.ts` | new `describe("Agent cancel")` block: the red-first regression tests below. |

No protocol, daemon, client, cli, or TUI changes (the events emitted are the
existing `tool_result` / `turn_end` variants; AGENTS §7 additive-only).

### Failure modes

- **Abort after the last event, before tools** (point 1): caught by check 1 —
  no push, no tools, `turn_end: cancelled`.
- **Abort during tool #k of N** (point 2): tool #k runs to completion (the
  loop is not inside its `await`), then check 2 synthesizes results for
  #k+1…#N and the next iteration-top check ends the turn `cancelled`. The
  in-flight tool's real result is still recorded (we await it) — no lost
  side-effect, matching history-validity-invariant row D's property.
- **A tool that ignores `ctx.signal`**: the loop does not rely on tools
  honouring it; the check after the `await` stops the rest regardless.
- **`ask`-level tools**: `authorize` is inside `runTool`, never reached for a
  skipped call → no prompt after cancel.
- **`--resume` on the cancelled round**: history is
  `assistant[toolCalls: c1,c2] → tool(c1, real) → tool(c2, synthetic, isError)`
  — every id answered, valid wire payload.
- **No signal / `signal` undefined**: every check is `signal?.aborted` →
  no behaviour change (all existing tests stay green).
- **Steering**: an abort that lands while steering was queued ends the turn at
  the next iteration top (existing check, `:193`); steering is not drained —
  correct (the user cancelled).
- **Sub-agents**: child shares the turn signal (precondition 6); a cancelled
  child ends `cancelled` inside `runTool` (which resolves normally with the
  child's report), so the parent records a real result for `agent_task` and
  its own check 2 stops further calls. No change to the `agent_task` note
  (`task.ts:65-69` already renders `_(sub-agent cancelled)_`).
- **Out of scope (separate, low priority):** racing the batch-fallback
  `ProxyModelProvider` (`packages/daemon/src/proxy-model.ts:181`) against the
  signal — mixed-version laptops only; points 1–2 already stop the *actions*,
  the remaining cost is the wait. Track in TODO.

### Tests

`packages/agent/test/agent.test.ts`, new `describe("Agent cancel")` block.
Fakes: the existing `ScriptedProvider` is signal-blind, so add a
`SignalDelayProvider` — a provider that yields N slow text deltas, optionally
honours the signal by throwing `AbortError`, and emits scripted `tool_call`s
— plus a slow `echo`-style tool that ignores `ctx.signal` (sleeps a fixed time
and records call order/timestamps). Deterministic timing via `bun:test` (no
flaky sleeps beyond the existing style in this file; the eval's in-process
repro already pins the wall-clock shape).

Red-first (§9) — each must FAIL on current `main`:
1. **post-stream, tool call**: model completes (ignores signal) *after* the
   test aborts, with one tool call → assert: no `tool_start`/`tool_result`
   events, last event `turn_end: cancelled`, and the model was **not** asked
   for a second round. (Today: the tool runs — red.)
2. **post-stream, text only**: same but no tool calls → assert: the late
   reply is **not** in the persisted `messages` and reason is `cancelled`,
   not `end_turn`. (Today: `end_turn` + reply kept — red.)
3. **between tools**: model returns two tool calls immediately; abort fires
   while tool #1 (slow, signal-ignoring) runs → assert: tool #2 never starts
   (no `tool_start` for c2), a `tool_result` for c2 **is** emitted with
   `isError: true`, and `messages` contains a `tool` message for c2 (no
   dangling call). (Today: tool #2 runs — red.)
4. **well-behaved provider unchanged**: model throws `AbortError` on abort →
   assert the existing clean path (`turn_end: cancelled`, nothing pushed).
   (Green on both old and new code by design — it pins that checks 1–2 don't
   regress the working path; kept as a guard, not a red test.)

Non-vacuity (§9): mutate each new check away (comment it out in turn) and
confirm its test fails: check 1 → tests 1+2 fail; check 2 → test 3 fails.
Test 3's synthetic-result assertion also fails if the result is pushed without
the `tool_result` event (or vice versa).

Validation: `bun test packages/agent/test/agent.test.ts` per slice; then the
eval's repro from Context re-run in `.tentacle/tmp/proxy-model-cancel/`
(`ignore`/`twoTools` now show no post-cancel tool starts); then
`bun run check` (typecheck → lint → test) green against the clean baseline.

### Notes/debt

- The batch-fallback wait (point 3 of Context) is deliberately left: a
  mixed-version concern, no actions leak after this fix. Candidate for a
  small follow-up `fix` (race `send` against the signal in
  `proxy-model.ts`).
- The broader dangling-call class (unguarded throws mid-round) stays with
  [`history-validity-invariant`](../eval/history-validity-invariant.md); this
  fix only needs to not make it *worse*, and its synthetic-result choice is
  the same shape that eval recommends, so the future repair module and this
  code agree.

## Execution

*— Qwen3.8-27B-Q6, 2026-10-19*

As-built, in order:

1. **Repro first** (on current `main`, `.tentacle/tmp/proxy-model-cancel/`,
   `bun repro.ts`) — reproduced the Context output exactly: `chunked` fixed;
   `batch`/`ignore` ran tool #1 after the cancel; `twoTools` ran tool #2
   (at ~607 ms) after the cancel.
2. **Red tests first** — added a `describe("Agent cancel (post-stream /
   between-tools)")` block to `packages/agent/test/agent.test.ts` with 4 tests.
   On the buggy code: **3 fail, 1 pass** (the honouring-provider guard passes
   by design — it pins the working `catch` path, it is not a red test).
   - Early draft aborted *before* the turn started, which the existing
     iteration-top check (`agent.ts:193`) already handles — a vacuous red.
     Caught it before running and changed to a mid-stream abort timer, which
     reaches the actual post-stream gap.
3. **Fix** — `packages/agent/src/agent.ts` only, 3 loop-boundary checks + the
   `CANCELLED_TOOL_NOTE` constant (per Implementation):
   - post-stream check between the stream `catch` and the assistant
     `messages.push`;
   - between-tools check at the top of the `for (const call of toolCalls)`
     loop, synthesizing a `tool` message + `tool_result` (isError) per skipped
     call (no `tool_start` for skipped calls);
   - post-final-stream check in the `max_iterations` path (cancel wins over
     `max_iterations`; the late summary is not pushed).
4. **Non-vacuity by mutation** (§9): each new check neutralized in turn
   (`if (false && signal?.aborted)`), confirmed its test fails, restored:
   - check 1 off → both post-stream tests fail (test 1's history assertion
     is what pins it, since check 2 alone would still synthesize the c1
     result);
   - check 2 off → the between-tools test fails (tool #2 runs).
   Restored file is byte-identical to the fixed version (`diff` clean).
5. **Gate** — `bun run check`: typecheck ✓, lint ✓ (one auto-fixable
   formatting nit in the new tests, fixed with `biome check --write`), test
   ✓ **725 pass / 1 skip (opt-in live-k8s) / 0 fail** — the pre-existing
   baseline.
6. **Repro re-run** (post-fix): `batch`/`ignore` now `toolsRan: []` with
   `reason: cancelled`; `twoTools` runs only tool #1 (started before the
   cancel) and ends `cancelled`; `chunked` unchanged.

**Drift from Implementation:** none — files, checks, and the
synthetic-result decision are exactly as planned. One test-shape refinement
mid-Execution (pre-abort → mid-stream abort timer) that the Implementation's
Tests section already describes ("abort fires while tool #1 runs").

7. **Post-Review round 1 (nits resolved):** added the regression test for
   check 3 (round-1 Finding 1) — a provider that completes the tools-less
   `max_iterations` final stream *after* the abort (abort at 50 ms, final
   stream takes 200 ms) → asserts `turn_end: cancelled` and the late summary
   is **not** pushed. It is green with the fix and **red with check 3
   neutralized** (mutation verified). Note: round 1 called check 3 "dead
   code" — the test shows it is *reachable* (an abort landing *during* the
   final stream, after the pre-existing `!signal?.aborted` guard at the top
   of that block passes); what it lacked was a test, which it now has. Gate
   re-run: **726 pass / 1 skip (opt-in live-k8s) / 0 fail**.
   *Round-2 (cross-model) correction on the red count:* with the 5th test in,
   the block is **4 fail / 1 pass** on `main`'s (un-fixed) code, not "3 fail"
   (the earlier figure predates the 5th test; the honouring-provider guard is
   the one pass). Recorded here so the doc's red-first figures are current.

8. **Post-Review round 2 (cross-model, claude-opus-5-5):** two nits.
   (a) *Sibling cancel case:* an abort landing during the **last tool** of a
   `maxIterations` turn (after the iteration-top check, before the final
   stream) ended `max_iterations`, not `cancelled` — a pre-existing
   reason-label mislabel round 2 confirmed on `main` (no tool-run leak).
   Round 2 sanctioned the 3-line fix ("re-check after the tool loop and end
   `cancelled`"); it is the *same* "cancel wins over `max_iterations`" intent
   as Implementation design point 3. Added **check 4** — a post-tool-loop
   `signal?.aborted` → `cancelled` right before the final-stream block
   (`agent.ts`, between the `for`-loop close and the `if (!signal?.aborted)`
   final-turn block) — and a 6th regression test
   (`"a cancel during the last tool of a capped turn ends cancelled, not
   max_iterations"`): `maxIterations: 1`, one slow signal-ignoring tool, abort
   at 30 ms / tool 120 ms → asserts `reason: cancelled` (red on round-2 code,
   green after check 4; neutralizing check 4 makes it fail; restored
   byte-identical). No-signal `maxIterations` behaviour is untouched (the
   pre-existing `maxIterations` tests stay green).
   (b) *Doc coherence:* the red-on-`main` count correction above (item 7)
   resolves it. Gate re-run: **727 pass / 1 skip (opt-in live-k8s) / 0 fail**.

9. **Post-Review round 3 (cross-model, claude-opus-5-5, fresh session):**
   three findings, all resolved.
   (a) *Latent gap — a tool can start after a cancel if its permission prompt
   is approved late.* `runTool` (`agent.ts`) awaited `gate.authorize` and then
   called `tools.execute` with no abort check between them, so a signal-blind
   requester (a non-TUI frontend, ACP, or any requester that outlives the
   abort) that approves *after* the cancel would still start the tool. The
   shipped TUI never hits it (Esc denies, `App.tsx:618`; Ctrl+C denies then
   aborts, `App.tsx:605-607`; a disconnect fails safe, `connection.ts:208`),
   so the invariant held only because of the frontend, not the loop. **Fix:**
   a `if (ctx.signal.aborted)` re-check right after `authorize` returns true,
   returning the `CANCELLED_TOOL_NOTE` result (isError). **Test (red-first):**
   `"a tool approved after the cancel does not run"` — an `ask` tool, abort at
   30 ms, a signal-blind requester approving at 100 ms → asserts `ran: []`, an
   `isError` `tool_result` with the note, and `turn_end: cancelled`. Red on the
   pre-fix code (the tool ran: `ran: ["write#1"]`, matching the round-3 repro
   exactly), green after, non-vacuous by mutation. This puts the invariant in
   the loop, as the fix claims.
   (b) *Index nit — the batch-fallback follow-up lived only as a clause inside
   the parent TODO item* and would be lost when the item closed at merge.
   Split it into its own `[ ]` line in `TODO.md`.
   (c) *Index nit — the parent TODO item still read as open* ("the requested
   tool still runs"). Reworded to "…could still run" and marked **FIXED (on
   branch, pending merge)**; left `[ ]` until it is actually merged (flipping
   it now would be a false state).
   Gate re-run: **728 pass / 1 skip (opt-in live-k8s) / 0 fail**. The cancel
   test block is now **8 tests**, all green.

**Unverified (one line):** a real pod/k8s run and a live provider's
just-after-last-SSE-event window — the repro is in-process over
`createChannelPair`; verify by Esc-ing a real `run` pod mid-tool-round.

## Review

*— claude-opus-5-5, fresh context (new session, not the executor), 2026-10-19
— **Round 3 (supersedes round 2)** *

**Verdict: APPROVE-WITH-NITS.** The four loop checks are correct, minimal and
each pinned by a non-vacuous test. Round 3 found **one latent gap of the same
class** (a tool can still start after a cancel if its permission prompt is
approved *after* the abort) and **two doc/index nits**. None of them is
reachable from the shipped TUI today, so none gates merge. Finding 1 is a
cheap, recommended hardening.

#### Gate (re-run)

`bun run check` → typecheck clean · `biome check .` 256 files, no fixes ·
**727 pass / 1 skip / 0 fail** (2238 expects, 91 files). Cancel block run
**30×** in a row (`-t "Agent cancel"`): **0/30 fails**.

#### Mutation non-vacuity (each check → `false`, one at a time; then restored)

| Check (`agent.ts`) | Failing tests |
|---|---|
| 1 post-stream `:251` | 2 (does not run its tools, does not keep its reply) |
| 2 between-tools `:296` | 1 (cancel during tool #1 stops tool #2) |
| 4 post-tool-loop `:339` | 1 (last tool of a capped turn → `cancelled`) |
| 3 final-stream `:381` | 1 (max-iterations final stream drops the late summary) |

After the restore, `agent.ts` is byte-identical to the original (`shasum` b004c5b…).

#### Findings

1. **Latent (low): approving a permission prompt *after* the abort still
   starts the tool.** `runTool` (`agent.ts:471-478`) awaits
   `gate.authorize` and then calls `tools.execute` with no abort check
   between them. Check 2 (`:296`) runs *before* `runTool`, so it can't see an
   abort that lands while the prompt is open. Repro
   (`.tentacle/tmp/review3-proxy-model-cancel/perm.ts`): an `ask` tool, abort
   at 30 ms, and a signal-blind requester that resolves `allowed` at 100 ms
   →
   `{ abortedAtEnd: true, ran: ["write#1"], events: [tool_start, tool_result, turn_end:cancelled] }`.
   The tool ran after the cancel, and the turn still reported `cancelled`.
   **Why the TUI doesn't hit it today:** while the dialog is up it owns the
   keys. Esc means *deny* (`App.tsx:618`), and Ctrl+C means *deny, then
   abort* (`App.tsx:605-607`). So no key sequence aborts the turn and leaves
   an approvable prompt behind. A daemon disconnect fails safe too
   (`connection.ts:208` → `cancelled` → deny). So the property "cancel ⇒ no
   new tool starts" currently holds because of how the **frontend**
   behaves, not because of the loop. An ACP or other frontend, or a requester
   that outlives the abort, would reopen the leak. **Suggestion:** in
   `runTool`, after `authorize` returns true, `if (ctx.signal.aborted)` →
   return the `CANCELLED_TOOL_NOTE` result (isError). Add a red-first test
   like the repro. This is one line, and it puts the invariant in the loop,
   which is where this fix claims it lives.
   **RESOLVED (executor, post-round-3):** added `if (ctx.signal.aborted)` right
   after `gate.authorize` returns true in `runTool` → returns
   `{ content: CANCELLED_TOOL_NOTE, isError: true }`. Plus a red-first test
   (`"a tool approved after the cancel does not run"`): an `ask` tool, abort at
   30 ms, a signal-blind requester that approves at 100 ms → asserts the tool
   never runs and the call is answered with the cancel note. It was **red** on
   the pre-fix code (the tool ran, `ran: ["write#1"]`, matching this finding's
   repro), **green** after, non-vacuous by mutation (neutralizing the `runTool`
   check → the test fails; restored byte-identical). See Execution item 9(a).
   Gate re-run **728 pass / 1 skip / 0 fail**.
2. **Nit (index): the batch-fallback follow-up is not tracked on its own.**
   The Implementation says "Track in TODO" (`:415`), but the only mention is a
   clause inside the parent item (`TODO.md:324`). When that item flips to
   `[x]` at merge, the follow-up disappears. Give it its own `[ ]` line.
   **RESOLVED (executor, post-round-3):** the follow-up now has its own `[ ]`
   line in `TODO.md` ("Pod `--model-proxy` batch fallback waits for the
   laptop's generation to finish after a cancel"), split off the parent item.
   See Execution item 9(b).
3. **Nit (index): `TODO.md:316` still reads as open.** The `[ ]` title still
   says "the requested tool still runs". Flip it to fixed (or "fixed on
   branch") as part of the merge.
   **RESOLVED (executor, post-round-3):** the parent item's title now reads
   "…the requested tool **could** still run" and the body is marked **FIXED
   (2026-10-19, on branch `fix/proxy-model-cancel`, pending merge — close with
   `[x]` at merge)**; it stays `[ ]` until it is actually merged to `main`
   (flipping it now would be a false index state). See Execution item 9(c).

#### Attacks tried

1. **Abort while a permission prompt is open → approve.** Found Finding 1
   (repro above). I traced the real TUI key routing and the RPC failure path
   to rate its reachability.
2. **`transformResult` during abort** (`agent.ts:329`, opt-in
   `summarizeLargeOutput`): the summariser gets the turn signal, and its
   abort is caught (`result-pipeline.ts:222-227`). The real result is
   recorded as a "summary failed" pointer with the full output spilled. No
   throw, no dangling call. **Nothing found.**
3. **Consumer exits early / turn drain:** `HostedSession.prompt`
   (`hosted-session.ts:100-110`) drains the generator up to `turn_end`. The
   synthetic `tool_result`s are emitted *before* the iteration-top
   `turn_end`, so they reach the wire. `Session.send`'s `finally` persists the
   history including the synthetic answers. **Nothing found.**
4. **Behaviour change in check 1 for a fully-streamed reply** (abort lands
   after the last delta, before the loop exits): the reply was visible in the
   UI but is now dropped from history (on `main` it was kept as `end_turn`).
   The catch path already does the same for partial text, so this is
   consistent. The window is a few microtasks. **Accepted, not a finding.**
5. **Timing flakiness** of the 6 timed tests: 30/30 green (see Gate).

#### What holds

The four checks cover every point where the loop can move from "stream
finished" to "start a tool" or to "report a reason", with one exception:
the permission await inside `runTool` (Finding 1). All four are guarded by
`signal?.aborted`, so a turn without a signal behaves as before. The
synthetic answers keep the history valid; rounds 1–2 verified this on the
OpenAI and Anthropic wire formats.

#### Sign-off

Reviewed by **claude-opus-5-5** in a fresh session, 2026-10-19. **Caveat
(§10):** this is the **same model** as round 2, so the shared blind spots
survive both passes. Only round 2 vs. the executor (Qwen) was cross-model.
The gate, mutation and repro evidence don't depend on which model ran them.
The executor (Qwen3.8-27B-Q6) didn't take part in this round.

---

*Round 2 below, kept as history (superseded by round 3).*

*— claude-opus-5-5 (Anthropic Claude Opus), fresh-context sub-agent, 2026-10-19
— **Round 2 (supersedes round 1)** *

**Verdict: APPROVE-WITH-NITS.** Both round-1 nits are **genuinely resolved**
(verified, not papered over): check 3 now has a non-vacuous, red-on-`main`,
non-flaky regression test, and the status header is current. The fix remains
correct and minimal. Round 2 found **one new nit** (a *pre-existing*
`max_iterations`-reason mislabel in a sibling cancel case the fix does not
cover) and **one doc-coherence nit** (the 5th test's red-on-`main` count is
undocumented). Neither gates merge.
*Post-round-2 (executor):* both nits are now **resolved** — the sibling
`max_iterations` mislabel is fixed by a new check 4 + 6th regression test
(Execution item 8(a)), and the red-on-`main` count is corrected (item 7 /
8(b)). Gate re-run **727 pass / 1 skip / 0 fail**. The two findings below are
marked **RESOLVED** inline.

**Scope of this round.** Verified the two round-1 resolutions adversarially
(mutation + red-on-`main` + timing), re-ran the gate, spot-checked the premise
citations the new test depends on, and confirmed the executor touched **only**
`packages/agent/test/agent.test.ts` (+194/0, pure additions) and the doc since
round 1 — `packages/agent/src/agent.ts` is **unchanged** (still +38; the three
round-1-cited checks are still at `:251`/`:296`/`:372`, so round 1's other
attacks verified an unchanged file and remain valid).

### Gate (re-run by this round-2 review)

`bun run check` (typecheck → lint → test), exit **0**:

- `tsc --noEmit` — clean.
- `biome check .` — clean (0 errors / 0 warnings; baseline per AGENTS §6).
- `bun test` — **726 pass / 1 skip / 0 fail**, **2236 expect() calls**, 727
  tests across 91 files. The 1 skip is the opt-in live-k8s test
  (`TENTACLE_K8S_SERVER` unset) — not a failure. (Round 1 was 725/1/0, 2234
  expects; the +1 test / +2 expects is exactly the 5th test and its two
  assertions.)

### The new check-3 test — non-vacuous, red on `main`, not flaky

The 5th test (`agent.test.ts:383`,
`"a cancel during the max-iterations final stream ends cancelled and drops the
late summary"`) — the heart of this round:

- **Non-vacuous (mutation):** neutralized check 3 (`agent.ts:372` →
  `if (false && signal?.aborted)`) → the 5th test **FAILS** (`reason` becomes
  `max_iterations`). Restored → tree byte-identical (`git diff` vs the
  pre-review snapshot). Also confirmed the **second half** of the property is
  independently pinned: with check 3 off *and* the `reason` assertion
  commented out, the `messages.filter(assistant).length === 1` assertion
  **also fails** (the late summary is pushed → 2 assistants). So the test
  pins the *property* (late summary dropped **and** reason cancelled), not a
  weaker correlate.
- **Red on `main`:** swapped in `main`'s (un-fixed) `agent.ts` → the block is
  **4 fail / 1 pass** (tests 1, 2, 3, and **5** fail; only the
  honouring-provider guard passes). The 5th test is genuinely red on the buggy
  code — **stronger** than the doc's "3 fail" (that figure predates the 5th
  test). Restored → byte-identical.
- **Flaky by timing? No.** Timeline: iteration-top guard `:196` at t≈0 (not
  aborted, passes) → round-1 stream (the `fast` tool, **no sleep**) + the tool
  loop run in the **microtask** phase (sync yields; `gate.authorize` returns
  `true` synchronously for a `none` tool; `fastTool.execute` has no
  `await sleep`) → the pre-final `!signal?.aborted` guard `:340` runs at
  **t≈1 ms** (still < the 50 ms timer, passes) → the final tools-less stream
  does `await sleep(200)` (a *macrotask*, t≈1→201 ms), during which the 50 ms
  `setTimeout` abort lands → check 3 `:372` sees `aborted` → `cancelled`. The
  only failure path is the abort firing *before* the `:340` guard, i.e. round
  1 + the tool loop taking ≥50 ms. That cannot happen: that span is pure
  microtasks (no `setTimeout`), and a 50 ms macrotask timer cannot fire while
  the microtask queue is still draining. **Margin ≈ 49 ms** (guard at ~1 ms
  vs timer at 50 ms). Ran the 5th test **40/40 pass**. **Verdict:
  deterministic / acceptably safe — not a flake.** (If it were ever made
  bulletproof, the abort could be triggered from inside the final stream's
  generator instead of a wall-clock timer — not necessary here.)
- **Pins the property, not a correlate:** yes — both `reason === "cancelled"`
  and "late summary not in `messages`" are asserted, and both are
  independently pinned (see mutation above).

### Premise spot-checks (the citations the new test + round 1 flagged)

| Claim (citation) | Verdict |
|---|---|
| Pre-final `!signal?.aborted` guard at `agent.ts:340` (round-1 F1; the test's reachability argument rests on it being *pre-existing* and passing) | **TRUE** — `:340` in the fixed file. Check 3 (`:372`) is **not present on `main`** (grep `final stream may complete` → 0 in `main`), so it is genuinely new; the guard is pre-existing and check 3 is the new addition *after* the stream. |
| Check 3 at `agent.ts:372`, after the final stream, before the summary push | **TRUE** — `:372` (`if (signal?.aborted)` → `cancelled`/return); summary push `:378`; final-turn catch `:381`; fall-through `max_iterations` `:389`. |
| Round-1-cited check lines `:251`/`:296`/`:372` still correct | **TRUE** — all three still at those lines in the fixed file; `agent.ts` is byte-for-byte the round-1 version (+38), so the executor did not touch it this round. |
| `CANCELLED_TOOL_NOTE` const at `agent.ts:44` (Impl) | **TRUE (±2)** — now at `:46` (the 2-line comment above shifted it); the constant is unchanged. |
| The 5th test is in the `Agent cancel (post-stream / between-tools)` describe block | **TRUE** — `agent.test.ts:250` (describe), `:383` (test). |

No false premises; the only drift is `CANCELLED_TOOL_NOTE` `:44→:46`
(cosmetic comment shift).

### Repro (re-run, post-fix)

`bun repro.ts` from `.tentacle/tmp/proxy-model-cancel/`:

```
{"scenario":"chunked","cancelAtMs":300,"turnEndMs":306,"reason":"cancelled","modelSawAbort":true,"modelCompletedAtMs":-1,"toolsRan":[]}
{"scenario":"batch","cancelAtMs":300,"turnEndMs":3044,"reason":"cancelled","modelSawAbort":false,"modelCompletedAtMs":3037,"toolsRan":[]}
{"scenario":"ignore","cancelAtMs":300,"turnEndMs":3038,"reason":"cancelled","modelSawAbort":true,"modelCompletedAtMs":3037,"toolsRan":[]}
{"scenario":"twoTools","cancelAtMs":300,"turnEndMs":612,"reason":"cancelled","modelSawAbort":true,"modelCompletedAtMs":206,"toolsRan":["#1@209ms"]}
```

Matches Execution item 6: `batch`/`ignore` `toolsRan: []`, `twoTools` only the
pre-cancel `#1` (no `#2`), `chunked` unchanged. **TRUE.**

### Mutation non-vacuity — ALL THREE checks (re-run, expected 2/1/1)

Neutralized each (`if (false && signal?.aborted)`), ran `agent.test.ts`,
restored; the tree was byte-identical after each (verified `git diff` vs the
pre-review snapshot every time).

| Mutation | Failures | Pinned by |
|---|---|---|
| Check 1 off (post-stream, `agent.ts:251`) | **2 fail** (both post-stream tests) | tests 1 + 2 |
| Check 2 off (between-tools, `agent.ts:296`) | **1 fail** (between-tools) | test 3 |
| Check 3 off (max-iter final stream, `agent.ts:372`) | **1 fail** (the 5th test) | test 5 |

Matches the doc's updated table (2/1/1). **All three checks are now
mutation-pinned.**

### Findings

1. **NEW (nit) — a sibling cancel case still reports `max_iterations`, not
   `cancelled` (pre-existing, out of scope).** `agent.ts:340`'s pre-existing
   `!signal?.aborted` guard skips the final summary stream *and* the turn then
   falls through to `agent.ts:389` (`yield max_iterations`) when the abort
   lands **during the last tool of a maxIterations turn** (after the
   iteration-top check, before the final stream). Check 3 (`:372`) cannot see
   this — it fires only *after* the final tools-less stream completes, which
   never starts in this case. Verified with a throwaway repro
   (`maxIterations:1`, one slow signal-ignoring tool, abort at 100 ms / tool
   400 ms): the turn ends **`max_iterations`** with the tool's result
   recorded. **Pre-existing on `main`** (swapped in `main`'s `agent.ts` →
   identical `max_iterations`), so the fix neither causes nor worsens it. It
   is the same "cancel wins over `max_iterations`" intent as Implementation
   design point 3, but that point only covers abort *during the final
   stream*, not abort *during the last tool*. The *actions* are already safe
   (no extra tool runs — the last tool had already started), so this is a
   **reason-label mislabel only**, not a tool-run leak. **Suggestion:** check
   `signal?.aborted` once more right after the tool loop (before the `:340`
   block) and end `cancelled`, *or* document the residual in Notes/debt. Does
   not gate merge (pre-existing, out of the stated post-stream/between-tools
   scope, no action leak).
   **RESOLVED (executor, post-round-2):** took the first option — added
   **check 4** (a post-tool-loop `signal?.aborted` → `cancelled` right before
   the `:340` block) plus a 6th regression test (red on the round-2 code,
   green after; non-vacuous by mutation — see Execution item 8(a)). `agent.ts`
   is now +47 (was +38); check 4 is a pure *addition* before the
   final-stream block, so it changes none of the paths round 1's attacks
   traced (they still hold).
2. **Doc-coherence (nit) — the 5th test's red-on-`main` count is undocumented;
   the doc's red-first figures still read "3 fail".** Execution item 2
   (`:479`) and round 1 (premise row 1 `:566`, mutation section `:597`) say
   "On the buggy code: **3 fail**, 1 pass" — accurate for the original 4-test
   block, but with the 5th test the block is now **4 fail / 1 pass** on
   `main` (verified). Item 7 documents the 5th test's red-ness via *mutation*
   ("red with check 3 neutralized") but not via red-on-`main`. Not a false
   claim — a completeness gap: recommend item 7 (or a round-2 note) record the
   4-fail red-on-`main` figure. Severity: nit.
   **RESOLVED (executor, post-round-2):** Execution item 7 now carries the
   round-2 correction ("4 fail / 1 pass" on `main` once the 5th test is in).
   See Execution item 8(b).

No other findings.

### Attacks tried (≥3, incl. those that found nothing)

1. **Is check 3 truly reachable, or did the executor paper over round-1
   Finding 1?** Traced line-by-line in the fixed file: `:340`
   `if (!signal?.aborted)` (pre-existing guard, passes if the abort lands
   *after* it) → final tools-less stream → `:372` check 3. Reachable **iff**
   the abort lands during the final stream (after `:340` passed) and the
   provider *completes* (not throws). The 5th test constructs exactly this
   (abort at 50 ms during a 200 ms final stream; provider ignores the
   signal). **Result: genuinely reachable and now pinned — round-1's "dead
   code" framing is corrected; the executor did NOT paper over it.** (The only
   "dead" case round 1 had in mind — abort landing *before* `:340` — is
   handled by `:340` itself, not check 3; check 3 is the post-stream
   complement, exactly as design point 3 intended.)
2. **Timing-flake analysis of the 5th test** (see "The new check-3 test"
   above). **Result: deterministic / acceptably safe, ~49 ms margin, 40/40
   pass. Not a finding.** The 50 ms abort timer cannot precede the `:340`
   guard (~1 ms, microtask phase) because the round-1 span is sleep-free and
   the 50 ms timer is a macrotask that cannot fire mid-microtask-drain.
3. **Does the 5th test / its timing introduce any NEW path or shared-state
   risk?** Checked: `clearTimeout(timer)` is called after `collect(...)`
   resolves (the stream always settles before the timer fires, so the clear is
   just cleanup — no leak, no cross-test contamination). The test uses its own
   `AbortController`, its own `ToolRegistry` (an inline `fastTool`, not the
   shared `slowTool`), and its own `messages` array — no shared mutable state
   with the other four cancel tests. `maxIterations:1` is per-Agent.
   **Result: no new path, no shared state, no interaction with the other
   tests.**
4. **Round-1 attacks (orphan `tool_result`, `--resume` wire mapping, sub-agent
   inheritance, no-signal, steering) still hold?** Verified `agent.ts` is
   byte-identical to the round-1 version (checks still at
   `:251`/`:296`/`:372`, +38 lines; the executor touched only the test file +
   doc this round). Since the code round-1's attacks verified is **unchanged**,
   its conclusions stand without re-running. **Result: valid.**
5. **Prior-art collision (grep `docs/eval`, `docs/fix`, `TODO.md` for touched
   symbols).** `CANCELLED_TOOL_NOTE`, `max_iterations`, `post-stream`,
   `between-tools` appear **only** in this doc (no other `docs/` or `TODO.md`
   item references them). `docs/eval/history-validity-invariant.md` (the
   dangling-pair class the synthetic-result choice aligns with) has no open
   item this change newly collides with — it already *recommends* synthetic
   results (row D), so the fix agrees with it. **Result: no collision.**
6. **Does the fix turn a loud failure into a silent wrong state (re-check,
   round-1 attack 6)?** Re-confirmed: every new path ends in
   `turn_end: cancelled` (visible) and skipped calls emit `tool_result`
   (`isError: true`). The only residual "late work" is the in-flight tool #k
   (already started, awaited) — intended. **Result: no silent drop.** (Caveat:
   Finding 1's `max_iterations` mislabel is a *visible* wrong label, not a
   silent one.)

### What holds

- **Both round-1 nits are genuinely resolved.** Finding 1 (check 3 untested /
  "dead") → the 5th test is non-vacuous, mutation-pinned, and **red on
  `main`** (4th red test). Finding 2 (stale status header) → header updated.
  Not papered over.
- **The core fix is correct and minimal** — three loop-boundary checks +
  `CANCELLED_TOOL_NOTE`, all gated on `signal?.aborted`, in the single
  `runMessages` choke point. +38 lines in `agent.ts`, no
  protocol/daemon/client/cli/TUI changes (AGENTS §7 additive-only). Unchanged
  since round 1.
- **Gate green** (726/1/0, 2236 expects); red-before-green verified (4 fail on
  `main`); all three checks mutation-pinned (2/1/1); repro matches.
- **`--resume`, sub-agent, no-signal, steering** (round-1 attacks 2–5) still
  hold — the code they verified is unchanged.
- **The 5th test is deterministic** (40/40, ~49 ms margin), pins the exact
  property, and introduces no new path or shared state.

### Verdict on both round-1 nit resolutions

- **Finding 1 (check 3 no test / "dead code") — RESOLVED, verified.** The 5th
  test exists, is non-vacuous (mutation → fail), is **red on `main`** (4th red
  test), pins the exact property (reason + dropped summary), and is not flaky.
  The executor's claim that check 3 is "reachable, not dead" is **correct** —
  it is reachable (abort during the final stream, after the `:340` guard
  passes) and is now proven by a real test. Round 1's "dead code" label was an
  overstatement; the accurate statement (the doc's) is "untested, now
  tested."
- **Finding 2 (stale status header) — RESOLVED, verified.** Header updated to
  reflect done + both nits resolved + ready-to-merge-on-OK. (Round 2 updated
  it again to reflect two reviews.)

### How the executor behaved on this round

Factually: the executor **followed the round-1 nudge faithfully and
minimally.** It added exactly one regression test (the 5th) to the existing
`Agent cancel` describe block — `agent.test.ts` is **+194/0 (pure additions;
no deletions or edits to the round-1 tests)** — and it did **not** touch
`agent.ts` (still +38; checks still at `:251`/`:296`/`:372`) or any other code
file. It updated the status header and the mutation table (now 2/1/1), and
added the Execution item 7 addendum explaining the reachability correction. No
`fs_edit`-corruption, no loops, no leftover `false &&`, no stray edits (git
status shows only the expected 4 files; the reflog shows a single clean
`main → fix/proxy-model-cancel` branch checkout, no file-restore incident).

**On the disclosed `git checkout` incident:** the parent asked me to check
whether the executor's earlier `git checkout` incident is "already disclosed in
Execution." I found **no such incident disclosed anywhere in the doc** (grep
for `checkout`/`incident`/`restored`/`revert`/`accident` returns only the
legitimate "restored byte-identical after mutation" notes and the
`main`-swap methodology). The reflog shows no file-restore checkout either. So
there is **no undisclosed checkout incident to reconcile** — either it did not
occur, or if it did it left no trace and was not claimed. Flagging this as a
factual note (not a finding): the doc makes no checkout-incident claim, so
there is nothing to verify as "honestly disclosed"; the Execution reads as
clean and honest on its face. (If the parent has specific evidence of a
checkout incident, it is not reflected in the working tree, the reflog, or the
doc.)

### Sign-off

Reviewed by **claude-opus-5-5 (Anthropic Claude Opus)**, fresh-context
sub-agent, 2026-10-19.

**§10 caveat:** Unlike round 1 (same family as the executor, Qwen3), **this
round is a cross-model review** — I am Claude; the executor is
Qwen3.8-27B-Q6. So the shared-training-blind-spot limitation round 1 flagged
does **not** apply here; this is the stronger guarantee §10 recommends for a
load-bearing fix. The gate, red-on-`main`, mutation, repro, and timing
evidence are independent of model identity and all hold. **This round-2
cross-model pass + round 1's fresh-context pass together satisfy §10's
mandatory fresh-context Review for this load-bearing (agent-loop) change.**

---

*Carried below as history (**round 1, superseded by round 2**): the first
adversarial fresh-context Review, whose two nits the executor resolved before
this round-2 pass.*

*— qwen3 (Qwen3.8-27B-Q6, fresh-context sub-agent), 2026-10-19 (round 1,
superseded by round 2; supersedes the 2026-10-19 eval-review verdict carried
further below as the Implementation's source)*

**Verdict (round 1): APPROVE-WITH-NITS.** The fix is correct, minimal, and
red-team clean on the load-bearing paths (checks 1–2, resume, sub-agent,
no-signal, steering). One nudge before merge: the third check
(max-iterations final stream) had **no regression test** and was called dead
code — see Finding 1. *(Round 2 confirmed the nudge was resolved and that the
"dead code" framing was an overstatement — the check is reachable.)*

**Scope note (round 1).** The code change is not committed — HEAD is still
`0f5d9b2` (= `main`), so `git diff main...HEAD` is empty. Reviewed the
working-tree change: `packages/agent/src/agent.ts` (+38) and
`packages/agent/test/agent.test.ts` (+149 *at round-1 time*; now +194 after
the round-2 test was added), plus the riding docs (`TODO.md`,
`docs/fix/proxy-model-cancel.md`). Code diff reviewed; docs diff skimmed for
consistency.

### Gate (re-run by this Review)

`bun run check` (typecheck → lint → test), exit **0**:

- `tsc --noEmit` — clean.
- `biome check .` — `Checked 256 files. No fixes applied.` (0 errors, 0
  warnings; baseline clean per AGENTS §6).
- `bun test` — **725 pass / 1 skip / 0 fail**, **2234 expect() calls**, 726
  tests across 91 files. The 1 skip is the opt-in live-k8s test
  (`TENTACLE_K8S_SERVER` unset) — not a failure.

### Premise table (Context symptom + every Implementation citation)

Line numbers verified against `main` (where the Context cites them) or the
fixed branch (where the Implementation cites them), as noted. All TRUE; three
carry ±1–2 line drift, none of which changes the claim.

| # | Claim (citation) | Verdict |
|---|---|---|
| 1 | Repro: cancel at 300 ms, `ignore`/`batch` run tool #1 after cancel; `twoTools` starts tool #2 ~607 ms after; `chunked` clean (Context) | **TRUE** — re-run the repro on this branch. Pre-fix (with `main`'s `agent.ts` swapped in): `batch` `toolsRan ["#1@3038ms"]`, `ignore` `["#1@3034ms"]`, `twoTools` `["#1@204ms","#2@606ms"]` (tool #2 at 606 ms, i.e. ~306 ms after the cancel), `chunked` clean — matches the Context output. Post-fix: `batch`/`ignore` `toolsRan: []`, `twoTools` `["#1@206ms"]` (only the pre-cancel tool), `chunked` unchanged — matches the Execution's claimed post-fix output. Red tests independently re-verified by swapping in `main`'s `agent.ts`: 3 fail, guard passes (see below). |
| 2 | No abort check after the stream ends normally; loop pushes the late assistant reply and runs tools (Context, `agent.ts:244`, `:283` on `main`) | **TRUE** — `main` `agent.ts:244` pushes, `:283` is the `for (const call of toolCalls)` loop with no per-call `aborted` check. |
| 3 | No between-tools abort check; tool #2 starts after a cancel in tool #1 (Context, `agent.ts:283` on `main`) | **TRUE** — same loop; the only abort checks on `main` are `:193` (iteration top) and `:237` (stream catch). |
| 4 | Batch fallback ignores the signal (Context, `proxy-model.ts:181`) | **TRUE (±2 lines)** — `await this.send(wire)` is `proxy-model.ts:183` on `main`; the batch `stream()` body is `:177-185`, signal-blind. Out of scope, tracked in TODO (see doc diff). |
| 5 | Existing abort checks: top of iteration `:193`, stream catch `:236`, pre-final-turn `:309`, final-turn catch `:343` (Impl precond. 1, `main`) | **TRUE (±1–2 lines)** — `main`: `:193`, `:237` (in the `:236` catch block), `:309`, `:343` (in the `:342` catch block). Same checks, off by ≤2 lines. |
| 6 | Assistant pushed **before** its tools run, leaving `toolCalls` unanswered on a between-tools abort (Impl precond. 2, `agent.ts:244-248`, `main`) | **TRUE** — `main` `:244-248` pushes, tools run in the `:283` loop after. Same dangling-pair class as `docs/eval/history-validity-invariant.md` row D (which showed abort-mid-tool is *safe* only because the loop keeps running; this fix stops early, so it must answer synthetically — which it does). |
| 7 | `Session.send` persists in `finally` after the generator settles (Impl precond. 3, `session.ts:69-75`) | **TRUE** — `session.ts:62-75`; `persist()` is in the `finally` of `send`, so whatever is in `messages` when the loop returns is what gets written. Verified end-to-end (Attack 2). |
| 8 | History well-formedness needs a `tool` message per `tool_call` id; a synthetic `{role:"tool", toolCallId}` is valid (Impl precond. 4, `core/model.ts:26-35`) | **TRUE** — `ChatMessage.toolCallId` (`model.ts:31`) links result to call; `toolCalls` on the assistant carries the ids. |
| 9 | A `tool_result` without a preceding `tool_start` is tolerated on every consumer (Impl precond. 5) | **TRUE** — `tui/state.ts:218-240` creates the item on demand when `idx < 0` (renders `args: ""`, `status: "error"`); `daemon/mapping.ts:82-88` maps to a plain `tool_call_update` (protocol `ToolCallUpdateSchema` has no `rawInput`/name — name is omitted, which is fine); `client/mapping.ts:98-104` reverse-maps with a `toolNames.get(...) ?? "tool"` fallback for the name (see Attack 1). No consumer breaks. |
| 10 | Sub-agents get the same signal (Impl precond. 6, `tools/task.ts:60-63`, `agent/subagent.ts:175-179`, `agent.ts:180-186`) | **TRUE (±1–2 lines)** — `task.ts:60-63` passes `ctx.signal` to the runner; `subagent.ts:175-179` feeds `controls?.signal` to the child's `run`; `toolContext.signal` is built from the turn signal at fixed `agent.ts:184` (`main` `:181`). Verified end-to-end (Attack 3). |
| 11 | The `max_iterations` final turn offers no tools, so only a post-stream check is needed there (Impl precond. 7, `agent.ts:312-342`, `main`) | **TRUE** — `main` `:321` streams with no `tools` key; `:339` pushes only the summary. No between-tools check exists there. |
| 12 | `ProxyModelProvider` forwards the caller's signal into a per-call `tunnel` controller (Context, `proxy-model.ts:199`) | **TRUE** — `proxy-model.ts:198-228` builds `tunnel`, wires the caller `signal`'s abort into it. |
| 13 | The peer sends `$/cancelRequest` on abort (Context, `transport/peer.ts:52`) | **TRUE** — `peer.ts:50-55` documents/implements the `signal` → `$/cancelRequest` path. |
| 14 | `serve.ts` wires both senders (Context, `cli/serve.ts:63-104`) | **TRUE** — `serve.ts:63-104` wires `sendModel` (batch) and `sendModelChunked` into the `ProxyModelProvider`. |
| 15 | `remote-client.ts` chunked handler gets the request's `signal` (Context, `client/remote-client.ts`) | **TRUE** — `remote-client.ts:223-294` takes `context.signal` and feeds the local provider. |

No false premises.

### Mutation non-vacuity (AGENTS §9)

Neutralized each new check in turn (`if (false && signal?.aborted)`), ran the
single test file, reverted. `git diff` is clean afterwards (verified: the
`agent.ts` diff is exactly the 3 checks + `CANCELLED_TOOL_NOTE` const, no
residual `false &&`).

| Mutation | Result | Pinned by |
|---|---|---|
| Check 1 off (post-stream, `agent.ts:251`) | **2 fail** (post-stream tool-call, post-stream text-only) | both post-stream tests |
| Check 2 off (between-tools, `agent.ts:296`) | **1 fail** (between-tools) | between-tools test |
| Check 3 off (max-iterations final stream, `agent.ts:372`) | **0 fail** (at review time) → **1 fail** after the executor added its regression test (Finding 1 resolved) | `a cancel during the max-iterations final stream ends cancelled and drops the late summary` |

Red-before-green independently re-verified: swapped in `main`'s `agent.ts` and
ran the file → exactly the 3 red tests fail, the honouring-provider guard
passes (14 total: 11 pass / 3 fail). Restored → 14 pass / 0 fail. Matches the
Execution's claim.

### Findings

1. **`agent.ts:372` (max-iterations final-stream check) has no regression
   test and is dead code.** The `if (!signal?.aborted)` guard at `agent.ts:340`
   (pre-existing) already prevents entering the final stream once aborted, and
   a provider that *throws* on abort is caught at `:381`. The only way to reach
   `:372` with `signal.aborted === true` is a provider that *completes
   normally after* the abort while the final stream is in flight — the same
   class check 1 covers, but for the tools-less summary turn. Because check 3
   is unreachable in every realistic path, mutating it off fails no test.
   Consequence: (a) the Implementation's "max-iterations symmetry" is
   unverified by the suite, and (b) if a provider ever completes late on the
   final stream, the late summary is still pushed to history (a pre-existing
   behaviour the fix does not change). **Nudge:** either add a regression test
   (a provider that completes after abort during the final stream → assert
   `turn_end: cancelled` and no late summary in `messages`) or drop check 3
   and note the residual in Notes/debt. Either is a ~10-line follow-up; the
   core fix is unaffected, so this is a nudge, not a blocker.
   **RESOLVED (executor, post-Review):** regression test added — see the
   Execution addendum (item 7) and the updated mutation table row above. The
   test also corrects this finding's "dead code" framing: check 3 is reachable
   (abort during the final stream), it was just untested.
2. **Doc status header is stale.** The top-of-doc line still reads
   "Execution/Review pending" (it was the eval's "Implementation approved
   below; Execution/Review pending"). Review is now done and the Execution
   section is filled. **Nudge:** update to "Execution/Review done; ready to
   merge on explicit user OK." **RESOLVED (executor, post-Review).**

No other findings. The two nits are cosmetic/coverage; neither changes
behaviour on the load-bearing paths. **Both resolved post-Review by the
executor (2026-10-19); gate re-run green (726 pass / 1 skip / 0 fail).**

### Attacks tried (≥3, incl. those that found nothing)

1. **Orphan `tool_result` (no preceding `tool_start`) through every consumer.**
   Traced `agent.ts:308-312` → `daemon/mapping.ts:82-88` (→ `tool_call_update`)
   → `client/mapping.ts:98-104` (→ `tool_result`, name via
   `toolNames.get(...) ?? "tool"`) → `tui/state.ts:218-240` (creates item on
   demand). **Result: no break.** One cosmetic nuance: over RPC (`connect`/
   `serve`) the wire `tool_call_update` drops the name, so the client falls
   back to `"tool"` for the synthetic item's label (the local/TUI path gets the
   real name from the event). A skipped call never emitted a `tool_call`, so
   there is no prior name to reuse — this is inherent to the wire shape, not a
   regression, and the item still renders as a failed tool with the note.
2. **History after a cancelled round survives `--resume` through the real
   provider wire mapping.** Wrote
   `.tentacle/tmp/review-proxy-model-cancel/trace.ts`: real `Session`
   (`onPersist`) + real `Agent` loop, abort at 300 ms while a slow signal-
   ignoring tool #1 runs. Persisted history =
   `user → assistant[toolCalls:c1,c2] → tool(c1, "ok-1") → tool(c2, CANCELLED_TOOL_NOTE)`;
   well-formedness check (every `tool_call` id answered by a later `tool` msg,
   no orphans) → **0 issues**. Re-sent that history through the **real
   `OpenAIProvider`** (fake `fetch` captured the body) and the **real
   Anthropic `buildPayload`**: OpenAI wire has `tool_calls:[c1,c2]` answered by
   two `role:"tool"` msgs (`tool_call_id` c1/c2), **0 dangling**; Anthropic
   wire has a `user` msg with `tool_result` blocks for **both c1 and c2**.
   **Result: resume is valid on both providers.**
3. **Sub-agent path (`agent_task` → `subagent.ts`) really inherits the signal.**
   Same trace script: parent `Agent` calls `agent_task` whose runner is a real
   `createSubagentRunner`; the child (a real `Agent`) gets two tool calls,
   abort at 300 ms while the child's tool #1 runs. **Result: the child runs
   only tool #1 (the pre-cancel one), ends `cancelled`; the parent records a
   real (cancelled-flavoured) `agent_task` result, ends `turn_end: cancelled`,
   and parent history is well-formed (0 issues).** The child's loop fix is
   inherited automatically, as precond. 6 claims.
4. **A turn with NO signal is unaffected (every check is `signal?.aborted`).**
   Trace part 3: `runMessages(messages, "s1")` with no signal → both tools run
   every round, `turn_end: max_iterations`, no `cancelled` event, no synthetic
   results. **Result: no behaviour change.**
5. **A steering message queued during the cancel: lost or double-injected?**
   `Session.send` resets `this.steering = []` at turn start and `enqueue`
   appends; the only drain is at the iteration top (`agent.ts:202`). A steering
   message queued mid-tool is drained at the *next* iteration top — but on
   cancel the loop ends at that same top (`agent.ts:196`) **before** the
   steering drain, so it is never injected (no double-injection) and is not
   re-queued (the `Session` steering array is a private per-turn scratch, reset
   next `send`). The TUI mirrors this: `run()`'s `finally` does
   `setQueued([])` and the steering text is already in command history
   (`pushHistory`) but not re-submitted. **Result: a steering message queued
   during a cancel is dropped on cancel — which matches the plan's explicit
   "Steering … steering is not drained — correct (the user cancelled)"
   failure-mode.** Not a regression; it is a deliberate (and pre-existing)
   design choice. Flagging only so it is consciously accepted: if a user
   expects a queued steer to be remembered after an accidental Esc, it is
   silently lost.
6. **Does the fix turn a loud failure into a silent wrong state?** No. Every
   new path ends in `turn_end: cancelled` (visible) and, for skipped calls,
   emits a `tool_result` (visible, `isError: true`) — nothing is dropped
   silently. The only "late work" still done is the in-flight tool #k (already
   started, awaited to completion — its real result is recorded), which is the
   intended, side-effect-honouring behaviour.
7. **In-flight tool #k + `ask`-level permission after Esc.** Check 2 sits at
   the loop top, *before* `runTool`/`gate.authorize`, so a skipped call never
   reaches `authorize` → no permission prompt after Esc. The in-flight tool is
   already past `authorize`. **Result: matches the plan; no prompt-after-Esc.**

### What holds

- **The core fix is correct and minimal.** Three loop-boundary checks, all
  gated on `signal?.aborted`, in the single choke point (`runMessages`) that
  every provider and runtime funnels through. +38 lines in `agent.ts`, no
  protocol/daemon/client/cli/TUI changes (the events emitted are existing
  `tool_result`/`turn_end` variants — AGENTS §7 additive-only).
- **Gate green** (725 pass / 1 opt-in skip / 0 fail / 2234 expects),
  red-before-green verified, checks 1–2 mutation-pinned.
- **`--resume` is valid** through both real provider wire mappings (Attack 2);
  the synthetic-result choice (option A) keeps the history well-formed and
  honest (the model sees the calls were cancelled, not silently missing).
- **Sub-agent inheritance** works (Attack 3); **no-signal turns** are
  unaffected (Attack 4); **steering** is not double-injected (Attack 5).
- **Preconditions** all verified TRUE (three with minor line drift, none
  changing the claim). The orphan-`tool_result` tolerance (precond. 5) is real
  on every consumer.
- **Out-of-scope** batch-fallback wait correctly deferred to TODO (the doc's
  TODO entry now reflects the promotion and the open follow-up).

### How the executor behaved

Factually: the executor (Qwen3.8-27B-Q6) **followed the brief well**. It
reproduced first, wrote red tests before the fix (and caught its own
early-abort vacuity, switching to a mid-stream abort timer — an honest,
self-correcting call noted in Execution), implemented exactly the three
planned checks + constant with no drift, did mutation non-vacuity (matching my
independent result), and ran the full gate. The diff is clean and small (no
`fs_edit`-corruption class, no stray edits, no leftover `false &&`). It
reported the unverified part honestly (real pod/k8s run + a live provider's
just-after-last-SSE-event window). No loops, no fs_edit corruption, no
over-claiming. The one gap is Finding 1: it implemented the third
(max-iterations) check but did not pin it with a test, and the Implementation's
non-vacuity plan only named tests for checks 1–2 — so the gap is partly a plan
under-specification, not purely an executor miss.

### Sign-off

Reviewed by **qwen3 (Qwen3.8-27B-Q6)**, fresh-context sub-agent, 2026-10-19.
**Shared-blind-spot caveat (AGENTS §10):** I am the same model family as the
executor (Qwen3), with only a fresh context — not an independent model. For a
load-bearing change (the agent loop) this is a real limitation: shared
training blind spots are not diversified by a fresh context. The gate,
red/green, mutation, and end-to-end wire-mapping evidence above are
independent of model identity and do hold; but per §10 this Review should be
treated as a same-family fresh-context pass, and a cross-model (e.g. Claude)
review is the stronger guarantee for a merge of a load-bearing fix.

---

*Carried further below (superseded by both rounds above): the 2026-10-19 eval
review whose fix-direction the Implementation was based on.*

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
