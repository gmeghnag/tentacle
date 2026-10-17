# fix/anthropic-error-hints — actionable messages for misconfiguration errors

> **Status:** done — merged 2026-10-17
> **Branch:** `fix/anthropic-error-hints`
> **Size:** S · **Blast:** contained (one provider's error path plus an optional field on the shared error type; no protocol, persistence or IO change) · **Suited:** any model + standard Review

## Context

*— claude-opus-5-5, 2026-10-17*

With `provider: "anthropic"` and no `model`, the model id stays `default`, so
the API returns 404. The owner asked that the resulting error be "parlante"
(it should say what to do). Repro (scratchpad `err404.ts`, fake fetch with the
API's error body):
```
ModelRequestError: model request failed with status 404: {"type":"error","error":{"type":"not_found_error","message":"model: default"},...}
```
The message identifies the problem but not which setting fixes it. A
missing key (401 `authentication_error`) has the same gap: nothing points at
`apiKey` / `apiKeyCommand` / `TENTACLE_MODEL_API_KEY`.

## Implementation

*— claude-opus-5-5, 2026-10-17*

- **Load-bearing assumption:** the TUI shows `String(error)`, which is the
  message, so a hint appended to `ModelRequestError.message` reaches the user.
  That covers the worker path too, where the message crosses RPC via
  `exposeInternalErrors`. The daemon error log appends the full body only when
  the message lacks it (`cli/src/daemon-log.ts:29-35`). That logic is
  unaffected, because the message still contains the body prefix.
- **Design:**
  - `anthropicErrorHint(status, body)` is a pure exported function. It parses
    the API error `type` and returns a hint for 404 `not_found_error` (set
    `model.model` / `TENTACLE_MODEL`) and for 401/403 `authentication_error`
    (set `model.apiKeyCommand` / `model.apiKey` / `TENTACLE_MODEL_API_KEY`).
  - It returns `undefined` for everything else and for a non-JSON body, and it
    never throws.
  - `ModelRequestError` gains an optional `hint`, appended to the message as
    ` — <hint>`. The OpenAI provider passes none, so its behaviour is
    unchanged.
- **Files:**
  - `packages/providers/src/anthropic-provider.ts`
  - `packages/providers/src/openai-provider.ts` (the error type only)
  - `packages/providers/test/anthropic-provider.test.ts`
- **Failure modes:**
  - non-JSON body (e.g. an HTML 404 from a wrong `baseURL`): no hint, no throw;
  - a gateway that reuses 404 for a missing route: the "check the model id"
    hint could mislead. The API body is still shown first, so the raw cause is
    never hidden.
- **Tests:** 4 new tests: two hints, the no-hint and non-JSON cases, and the
  hint reaching the thrown message.

## Execution

*— claude-opus-5-5, 2026-10-17*

As planned, no drift.
- **Red:** the new tests failed before the code existed. That first red was an
  import failure, which is weak evidence, so behaviour non-vacuity was also
  checked by mutation: removing the hint argument at the throw site makes "the
  hint reaches the thrown error message" FAIL (20 pass / 1 fail). The source
  was then restored and verified byte-identical with `cmp`.
- **Repro after the fix:** the 404 now ends with `— check the model id: set
  model.model in config.jsonc or TENTACLE_MODEL (e.g. claude-opus-5-5)`. The
  401 ends with the key settings.
- **Gate:** `bun run check` green: typecheck clean, lint 0/0,
  **680 pass / 1 skip / 0 fail**.

## Review

*— claude-opus-5-5, 2026-10-17 (in-context, same model as the author — allowed for `contained` S, AGENTS §10)*

**Verdict: APPROVE-WITH-NITS.**
- **Premises:**
  - TRUE: the TUI renders `String(error)`.
  - TRUE: the daemon-log body logic is unaffected, because it checks
    `message.includes(body)` and the message still embeds the body.
- **Attacks tried:**
  - (1) non-JSON body → no hint, no throw (tested);
  - (2) the OpenAI provider's message is unchanged when no hint is given
    (constructor default, existing OpenAI tests green);
  - (3) the hint is wired at the throw site, which the mutation proved.
- **Nit:** a gateway's route-level 404 would get the "model id" hint. The raw
  body is still shown first, so this is accepted.
