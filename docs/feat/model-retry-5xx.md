# feat/model-retry-5xx — Pre-stream retry of HTTP 500/502/503

> **Status:** done
> **Branch:** `feat/model-retry-5xx`
> **Size:** S · **Blast:** contained · **Suited:** any model; standard in-context Review

## Context

*— claude-opus-5-5, 2026-10-30*

Owner request (2026-10-30): the model-call retry should also cover HTTP 500,
502 and 503. Today `RetryingModelProvider` retries only transient connection
codes and HTTP 429/529 (`packages/providers/src/retry.ts:116` on `main`
`1459359`); any other `ModelRequestError` passes through after one attempt, so a
proxy's momentary 502, a provider's transient 500, or a local server's
`503 Loading model` fails the turn (or a sub-agent's whole task).
`feat/model-retry-429` left 5xx out by scope ("Nothing else"), not for a stated
reason (`docs/feat/model-retry-429.md` Context).

**Repro (feat: capability missing):** the existing test "non-transient errors
pass through untouched, after one attempt" used `new ModelRequestError(503,
"loading model")` and asserted one call (`packages/providers/test/retry.test.ts`
on `main`). The new tests below, run on unchanged `main` code (2026-10-30):

```
(fail) … > a 500, 502 or 503 before any output is retried, reported as its status
(fail) … > a 503's retry-after is honoured
(fail) … > an exhausted 5xx rethrows the original error after maxAttempts
 27 pass
 3 fail
```

## Implementation

*— claude-opus-5-5, 2026-10-30*

### Load-bearing assumption

A 5xx is retried only when no event has been delivered to the consumer, so a
retry can never duplicate output. Holds by construction: the 5xx path is the
same `limited` branch as 429/529, which rethrows when `emitted`
(`retry.ts` `RetryingModelProvider.stream`, the `if (emitted || attempt >=
maxAttempts || tooLong)` guard). An HTTP error status arrives before any body
(`openai-provider.ts:153`, `anthropic-provider.ts:101` throw on `!res.ok`), so
in practice a 5xx is always pre-stream; in-band stream errors are
`ModelRequestError(0, …)` (`anthropic-provider.ts:205`) and stay non-retryable.

### Preconditions

- No consumer classifies a 5xx `ModelRequestError` (no `instanceof
  ModelRequestError` / `.status` checks outside `packages/providers`, checked
  with `rg`): an exhausted retry rethrows the ORIGINAL error, so the only
  downstream change is a delay of at most ~1.5 s (two backoff steps) plus any
  `retry-after` ≤ 30 s.

### Design

Add 500, 502, 503 to `RETRYABLE_STATUSES`. Nothing else: same attempts (3),
backoff, `retry-after` cap, cancel precedence, `onRetry` log line (`HTTP 50x`).
504 deliberately excluded: it arrives after a long upstream wait, and retrying
would stall the turn that long again.

### Files

- `packages/providers/src/retry.ts` — the set + comments.
- `packages/providers/test/retry.test.ts` — tests.
- `CHANGELOG.md` — Unreleased / Changed.

### Failure modes

- Deterministic 500 (server bug, bad template): retried twice, then the same
  error surfaces — ~0.75–1.5 s later. Accepted.
- 503 with a huge `retry-after` (> 30 s): surfaces at once, as for 429.
- 5xx after output: never retried (test).
- Cancel during the wait: `abortableSleep` rejects at once (existing path).

### Tests

New: 500/502/503 pre-stream retried and reported as `HTTP <status>`; 503
`retry-after` honoured; exhausted 5xx rethrows the original after 3 calls; 5xx
after output not retried (guard, green on both). Changed: the pass-through test
now uses 400/401/504 instead of 503 (pins 504 as not retried).

## Execution

*— claude-opus-5-5, 2026-10-30*

As planned, no drift. Red on unchanged code (3 fail, above) → green (30 pass)
after adding the statuses. Gate: see Review.

## Review

*— claude-opus-5-5, 2026-10-30 (in-context, same model as the executor —
allowed for a contained S)*

### Verdict

**MERGE.** One-line behaviour change inside the existing retry branch; every
guard (pre-stream only, attempt cap, `retry-after` cap, cancel first) is shared
with 429/529 and already tested.

### Gate

`bun run check` (2026-10-30): typecheck clean, `biome check .` clean (555
files), `bun test` 3483 pass / 3 skip (the opt-in three) / 0 fail.

### Non-vacuity

Mutation: `503` removed from `RETRYABLE_STATUSES` → 2 tests fail (the
500/502/503 test and the 503 `retry-after` test); restored with `cp`, `shasum`
identical.

### Attacks tried

- Duplicate output: a 5xx after an event → 1 call, error as is (test).
- Downstream classification: none (`rg` for `ModelRequestError` / `.status`
  outside providers) — only latency changes.
- Pod reverse tunnel: the laptop side builds its provider through
  `configuredModelProvider` (`cli/src/model-provider.ts`), so it gets the same
  retry; nothing new crosses the wire.

### How the executing model behaved

Followed red → green → mutation → full gate; no scope creep (504 left out and
pinned by a test).
