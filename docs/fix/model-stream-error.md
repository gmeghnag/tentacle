# fix/model-stream-error — show the server's own error, and the remote hint only when it fits

Type: fix · Size: S · Blast: cross-module (providers stream parsing + TUI error line; protocol unchanged unless a field is needed) · Suited: Opus plan → executor → Opus review

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Owner 23/11 ~15:00, on the `~/assistant` serve (Qwen3.8 27B on llama.cpp at 192.168.1.17:8080, `-c 120000 --parallel 2 -kvu`: two slots sharing ONE 120k KV cache): the TUI showed «▲ the model's stream was cut before it produced anything» and «⚠ the model's stream was cut before it produced a reply (no stop reason) — the daemon runs its own model: check its config and key with "tentacle config" on that host». The llama.cpp log (read by the orchestrator over ssh) says the real cause:
```
E srv    send_error: task id = 257210, error: Context size has been exceeded.
E srv    send_error: task id = 259320, error: Context size has been exceeded.
```
(three concurrent requests — the turn, a sub-agent, a new turn — on two slots of a shared 120k cache; owner found the sub-agent). llama.cpp sends that error INSIDE the SSE stream (an error event/`data: {"error":…}`), and tentacle reported it as a stream with no stop reason.

Owner decisions: **(b)** when the server sends an error in the stream, tentacle shows THAT text (e.g. «model server error: Context size has been exceeded») — in the turn's error line, on Mac TUI and phone alike; **(c)** the remote hint «check its config and key with "tentacle config" on that host» (`packages/tui/src/model-error.ts:25`, appended to any error matching `MODEL_FAILURE`, `:18-19`) is shown only for errors it actually fits (auth / unreachable / connection: 401/403, ECONN*, ETIMEDOUT, DNS…) — NOT for a server-side generation error or an output-limit cut. The orchestrator's earlier option (a) («send now» waits for the old request to close) is dropped: the concurrency came from a sub-agent.

To verify in the plan (file:line): where the OpenAI-compatible provider parses SSE (`packages/providers/src/openai-provider.ts`) and what it does with an `error` event / a JSON `error` object in a `data:` line; the exact wording path to the TUI and the iPhone; the anthropic provider's equivalent (`event: error`); a red-first test with a recorded llama.cpp error stream (fake fetch, no network); the hint's regex tests (positive and negative cases, incl. the two strings above).

## Implementation

*— claude-opus-5-5 (planner), 2026-11-23*

**Implementation APPROVED (orchestrator, owner delegated: S fix).** The owner already took the two decisions, (b) and (c). Nothing below needs a new owner choice; the one judgment call (503 loses the hint) follows (c) to the letter and is noted under Failure modes.

### Load-bearing assumption

**The server's error text reaches the user only if the provider THROWS it. Today an in-band error is skipped without a sound, at two points, and the stream then looks like a plain cut.** Proof, end to end:

1. **SSE reader drops non-`data:` lines.** `packages/providers/src/sse.ts:24-26` (and the tail at `:43-45`) yields only lines starting with `data:`. llama.cpp's server writes a streamed error through `server_sent_event(sink, "error", err)`, which produces `error: {"code":…,"message":"Context size has been exceeded.","type":…}\n\n`. That is a non-standard SSE *field* named `error`, so it is lost here before any provider sees it.
2. **The OpenAI provider skips a JSON `error` object.** If a server sends the error as `data: {"error":{…}}` instead (the OpenAI/vLLM/OpenRouter shape), `parseChunk` (`openai-provider.ts:513-518`) parses it as a `WireChunk`. `WireChunk` (`:113-127`) has no `error` member and the object has no `choices`, so `:301-304` hits `continue`. Either way the loop ends with no `finish_reason`, and `:343` yields `done{stopReason:"other"}`.
3. **"other" becomes the two lines the owner saw.** `agent.ts:1646-1653` emits `truncated_reply{reason:"cut"}`, rendered as «▲ …cut before it produced anything» (`core/src/truncation.ts:47`). It then throws `ModelStreamCutError("no-stop-reason")`, which says «…cut before it produced a reply (no stop reason)» (`truncation.ts:116`).
4. **A provider throw reaches both screens word for word, after one sanitizing pass.**
   - The agent catch at `agent.ts:1593` rethrows anything that is not an abort.
   - `retry.ts:195-200` passes through any error that has no transient string `code` and is not a `ModelRequestError` with a retryable status.
   - The daemon then writes the text into `turn_end.error` through `redactTurnError` → `sanitizeTurnError` (`daemon/src/hosted-session.ts:649-669`). That step makes it one line, redacts secrets and caps the length. It runs only with `exposeTurnErrors`, which `serve` sets (`cli/src/serve.ts:768`) and so does the worker (`cli/src/worker.ts:177`).
   - **Mac TUI:** `useTurnDriver.ts:745-748` → `modelErrorNotice` (`tui/src/model-error.ts:34-46`).
   - **iPhone:** `apps/mobile/src/transcript.ts` `outcomeNotice` shows `input.message` unchanged as a warn notice. The mobile app appends no hint (`rg "tentacle config" apps/mobile/src` finds nothing).
   - With a throw before `done`, `truncated_reply` is never emitted, so the misleading «▲ cut» line also disappears.
   - **Protocol unchanged.** `turn_end.error` is already a string, so there is no bump and no `protocol.d/` note.
5. **The hint matches almost anything today.** `MODEL_FAILURE` (`model-error.ts:18-19`) includes `\bmodel\b`, so every one of these gets the remote hint: «the model's stream was cut…», «model server error: …», and «the reply was cut at the model's output limit». So does `status\s*\d{3}` (any 400/500) and anything that says `provider` or `http`.

The equivalent of "a cut list must be impossible" here: **no in-band error shape may end a stream silently.** Every recognized error shape throws. Unknown JSON is still skipped, as today, so a gateway's extra chunks don't break anything.

### Design

- **D1, SSE (`sse.ts`).** `parseSSE` yields a tagged item instead of a bare string: `export interface SseItem { readonly field: "data" | "error"; readonly value: string }`. The `error:` field is recognized in the line loop and in the tail flush (the same `slice`/`trim` as `data:`). Every other field (`event:`, `id:`, comments) is still ignored. Both callers change (D2, D4). This is the smallest explicit shape; tunnelling the error into a fake `data` string would hide it.
- **D2, a typed in-band error (`openai-provider.ts`, next to `ModelRequestError` at `:77`).**
  - Add `export class ModelServerError extends Error` with `readonly serverMessage: string`, `readonly serverType?: string` and `readonly serverCode?: number | string`.
  - The message is ``model server error: ${oneLine(serverMessage)}``, capped at 300 characters with `…`.
  - **It must NOT have a property called `code`.** `retry.ts:34-38` reads `error.code`, and an in-band error must never be taken for a transient connection error. In particular it must not be retried after output was already shown.
  - Add `export function inBandError(payload: unknown): ModelServerError | undefined` with these rules:
    - The payload has an object `error` member → use that object.
    - The payload is itself `{message: string, …}` (llama.cpp's bare `error:` field) → use it.
    - A string `error` → that string is the message.
    - The object has no string `message` → the message is `JSON.stringify(obj).slice(0, 200)`.
    - Anything else → `undefined`.
- **D3, OpenAI loop (`openai-provider.ts:266-322`).**
  - An item with `field === "error"`: `JSON.parse` it inside a try; if it is not JSON, the raw text is the message. Throw `inBandError(...) ?? new ModelServerError(raw)`.
  - A `data` item: after `parseChunk`, check `inBandError(chunk)` **before** `choices`, and throw if it returns an error. This also covers OpenRouter's `{error, choices:[{finish_reason:"error"}]}`.
  - Extend `WireChunk` with `readonly error?: unknown`.
  - The throw comes before `done`, so no "other" is ever produced for these streams. Text already streamed stays on screen. The agent's throw path (`agent.ts:1593`) decides what history keeps, exactly as for any provider throw today.
- **D4, Anthropic (`anthropic-provider.ts:208`, `:302-303`).**
  - Iterate `SseItem`. A `data` item works as today.
  - The `case "error"` branch throws `inBandError(event) ?? new ModelServerError(JSON.stringify(event).slice(0, 200))` instead of `ModelRequestError(0, …)`.
  - An `error`-field item, which Anthropic never sends, throws the same way, so the two providers behave alike.
  - Result: «model server error: Overloaded» replaces «model request failed with status 0: {…}».
- **D5, hint fits only config/reachability (`tui/src/model-error.ts:17-19`).**
  - Rename `MODEL_FAILURE` to `REMOTE_CONFIG_FAILURE`:
    `/status\s*(?:401|403|404|407)\b|\bECONN[A-Z]+\b|\bETIMEDOUT\b|\bEPIPE\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bE(?:HOST|NET)UNREACH\b|\bunreachable\b|could not connect|\bapi[-_ ]?key\b|\bunauthori[sz]ed\b|\bauthentication\b/i`
  - The doc comment states owner decision (c). The case it covers is 401/403 (key), 404 (wrong URL or model) or 407 (proxy), plus connect, DNS and timeout failures: the setting to fix is on that host. A server-side generation error, a 400/5xx answer, or an output-limit or stream cut gets the text only.
  - The local path (`remote === false`) is unchanged.

### Files (dependency order)

1. `packages/providers/src/sse.ts`: `SseItem` and the `error:` field.
2. `packages/providers/src/openai-provider.ts`: `ModelServerError`, `inBandError`, `WireChunk.error`, and the loop checks.
3. `packages/providers/src/anthropic-provider.ts`: `SseItem` iteration and the `case "error"` branch.
4. `packages/providers/src/index.ts`: export `ModelServerError` (and `inBandError` if tests import it from the barrel).
5. `packages/tui/src/model-error.ts`: the regex and its comment.
6. Tests (below), `changelog.d/model-stream-error.fixed.md` (one bullet: the server's own error is shown, and the remote hint only when it fits), and this doc's Execution.

No protocol, daemon, client, cli or mobile source changes.

### Failure modes

| Case | Converges to |
|---|---|
| llama.cpp `error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}` after some text | throws `model server error: Context size has been exceeded.`; no `truncated_reply`; turn fails with that text on Mac and phone; no hint |
| Same as `data: {"error":{…}}` | same |
| `error:` line that is not JSON (`error: boom`) | `model server error: boom` |
| Error object without `message` | message = its JSON, capped 200 |
| Error before any output (no text) | same throw; retry does not retry (no `code`, not a `ModelRequestError`); one fetch |
| Error after a tool-call delta | throws before `tools.drain()`, so no partial call is ever yielded or run |
| Abort during stream | `parseSSE` returns on `signal.aborted` (`sse.ts:32`), so the agent's cancel path is unchanged |
| `event: error` line followed by a normal `data:` | the `event:` field is still ignored; the data is judged by D3, so an Anthropic-style error object throws and anything else is unchanged |
| Server error message holds a secret or is huge | capped 300 here; daemon `sanitizeTurnError` redacts and caps again; TUI `MODEL_ERROR_MAX` caps once more |
| Non-stream 400 «context exceeded» (newer llama.cpp sends the first error as an HTTP answer) | unchanged `ModelRequestError(400)`; with D5 it no longer gets the hint. Extracting its JSON `message` is **debt**, out of scope |
| Remote 503 / 500 | **loses the hint** under D5. This applies (c): server-side, not config/key/reachability. The existing test case «HTTP 503 from the provider» moves to the negative list |

### Tests (red first; show each failing on the current tree, then green)

1. **`packages/providers/test/openai-stream-error.test.ts`** (new). It uses an injected `fetch` (config `fetch`, `openai-provider.ts:54`) that returns a `ReadableStream` of recorded bytes; there is no network. Bodies:
   - (a) llama.cpp: `t("ok")` then `error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}\n\n`. The stream must reject with a `ModelServerError` whose message is exactly `model server error: Context size has been exceeded.`. The events before the rejection contain no `done`. **RED today:** it yields `done{stopReason:"other"}`.
   - (b) the same error as `data: {"error":{…}}`. Same assertion.
   - (c) a non-JSON `error: boom`.
   - (d) the error after a partial tool-call delta: no `tool_call` event is yielded.
   - (e) through `createModelProvider` (retry wrapper) with the error before output: exactly one fetch call, and the error is still a `ModelServerError`.
   - (f) **control:** a normal stream with `finish_reason:"stop"` still gives `done{stop}`, and `data: {"foo":1}` is still skipped.
2. **`packages/providers/test/sse.test.ts`**: update it for `SseItem`, and add a test that `error:` lines in the body and in the trailing flush come out as `field:"error"` while `event:`/`id:` stay dropped. Red: the `error` item is missing today.
3. **`packages/providers/test/anthropic-provider.test.ts:467`**: assert `instanceof ModelServerError` and message `model server error: Overloaded`. Red: today the message is `…status 0: {…}`.
4. **`packages/tui/test/model-error.test.ts`**:
   - Positive (hint): `model request failed with status 401: Invalid API Key`, `…status 403…`, `could not connect to the model endpoint (ECONNREFUSED)…`, `model unreachable: 127.0.0.1:8080 did not answer in 15s`, `getaddrinfo ENOTFOUND gpu-box`.
   - Negative (exact text, no hint): **the owner's two strings**, `the model's stream was cut before it produced a reply (no stop reason)` and `the model's stream was cut before it produced anything`; also `model server error: Context size has been exceeded.`, `the reply was cut at the model's output limit — this answer is incomplete`, `model request failed with status 400: {"error":…}`, `model request failed with status 500: x`, `HTTP 503 from the provider` (moved from the positive list).
   - Red: every negative fails today.
5. **Mac/iPhone parity pin.** One TUI test in `truncated-reply-notice.test.tsx`'s harness style: a remote turn failing with `model server error: Context size has been exceeded.` renders that line with no `tentacle config` and no `▲ … cut` line. One `apps/mobile` transcript test: `turn_ended{outcome:"failed", message:"model server error: Context size has been exceeded."}` gives a warn notice with exactly that text. The mobile test is green on both trees; it pins parity and is not the red test, so say so in Execution.
6. **Non-vacuity check (§9):** revert D1's `error:` branch and confirm test 1(a) fails; revert D3's `inBandError(chunk)` check and confirm 1(b) fails.

Gate: `bun run check` (typecheck, then lint against the clean baseline, then the full test suite, with only the three opt-in skips).

## Execution

## Review
