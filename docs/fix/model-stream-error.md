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

## Execution

## Review
