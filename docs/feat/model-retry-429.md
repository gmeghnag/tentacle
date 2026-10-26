# feat/model-retry-429 — Pre-stream 429/529 retry honouring `retry-after`

> **Status:** execution
> **Branch:** `feat/model-retry-429`
> **Size:** S · **Blast:** contained · **Suited:** a weaker model may execute; standard in-context Review

## Context

*— claude-sonnet-5-5, 2026-10-26*

Source: `.tentacle/tmp/plans/parallel-eval.md` §2.3 "Rate limits" (row 3 of the
split table). `RetryingModelProvider` retries only connection codes
(`providers/src/retry.ts:20-25`); an HTTP 429 (rate limit) or 529 (Anthropic
overloaded) is a `ModelRequestError` and passes through, so a sub-agent hit by a
rate limit fails its whole task. Parallel agents make this likely on a cloud API
with per-organisation limits. Scope: retry 429/529 **pre-stream only**, honour
`retry-after`, bounded attempts. Nothing else.

**Repro (feat: capability missing):** a `scripted` inner throwing
`new ModelRequestError(429, …)` is called once and the error surfaces — this is
the existing test "non-transient errors pass through untouched"
(`packages/providers/test/retry.test.ts:152-164`, which uses a 503).

## Implementation

*— claude-sonnet-5-5, 2026-10-26*

### Load-bearing assumption

Both providers raise the HTTP failure BEFORE yielding any event, so a
`ModelRequestError` with status 429/529 and `emitted === false` is safely
retryable. Cited: `anthropic-provider.ts:99-102` and `openai-provider.ts:132-134`
throw right after `doFetch`, before the stream loop. The retry loop already
tracks `emitted` (`retry.ts:155-160`).

### Preconditions

- `ModelRequestError` is defined in `openai-provider.ts:38-50` and imported by
  the Anthropic provider (`anthropic-provider.ts:28`); the throw sites have the
  `Response` (`res.headers`) at hand. In-stream Anthropic errors use status `0`
  (`anthropic-provider.ts:200`) → never matched.
- `RetryInfo.code` is a `string` and is only logged
  (`cli/src/daemon-log.ts:78`) → `"HTTP 429"` fits with no cli change.
- No §7 invariant, protocol schema or persisted format is touched; the error
  object is not serialised across the wire by this change.

### Design

- `ModelRequestError` gets an optional 4th ctor arg `retryAfterMs` (readonly).
  New pure helper `parseRetryAfter(headers, now?)` (next to the class): seconds
  (`"3"`, `"1.5"`) or HTTP-date → ms, `undefined` if absent/invalid/negative.
  Both throw sites pass it.
- `retry.ts`: `retryableStatus(error)` → `429|529` on a `ModelRequestError`.
  In the catch: abort wins first (unchanged); then connection code OR retryable
  status. A status error with `emitted` or at `attempt >= maxAttempts` is
  rethrown **as-is** (its message and hint stay). Delay = `max(backoff,
  retryAfterMs)`; if `retryAfterMs > maxRetryAfterMs` (policy, default 30 s) the
  wait would stall the turn → rethrow as-is. `onRetry` code `"HTTP 429"`.
- Same attempt budget (3) as connection drops; abortable sleep is reused.

### Files

1. `packages/providers/src/openai-provider.ts` — `retryAfterMs` + `parseRetryAfter`; pass at the throw.
2. `packages/providers/src/anthropic-provider.ts` — pass at the throw.
3. `packages/providers/src/retry.ts` — policy `maxRetryAfterMs`, status branch, header comment.
4. `packages/providers/test/retry.test.ts` (+ parse/throw tests in provider tests).

### Failure modes

- Cancel during/before the wait → abort check first, abortable sleep (existing).
- Output already emitted → never retried, error as-is.
- Attempts exhausted → original `ModelRequestError` (status visible to the user).
- `retry-after` huge (hours) → not honoured, error surfaces at once.
- `retry-after` garbage / missing → plain backoff.
- Other statuses (400, 401, 500, 503) → unchanged pass-through.

### Tests

Red first on `retry.test.ts` with `scripted` + `fakeSleep`:
429 then OK recovers with a backoff wait; `retry-after` 2 s waits ≥ 2000 and
`onRetry.code === "HTTP 429"`; 529 retried; exhausted → the same error object,
3 calls; huge `retry-after` → 1 call; emitted-then-429 → 1 call; 503/400 still
pass through. `parseRetryAfter` unit cases; a provider test that a 429 response
with the header yields `retryAfterMs`. Mutation: drop the status branch (or the
`max(…, retryAfterMs)`) and see the key test fail.

## Execution

*— claude-sonnet-5-5, 2026-10-26*

Done as planned: `ModelRequestError.retryAfterMs` + `parseRetryAfter`
(`openai-provider.ts`), both providers pass it at the throw, `retry.ts` retries
429/529 pre-stream with `max(backoff, retry-after)`, `maxRetryAfterMs` (30 s) cap,
exhausted/emitted/too-long → original error as is, `onRetry.code = "HTTP 429"`.

- **Red:** `bun test packages/providers/test/retry.test.ts` → `25 pass / 6 fail`
  (e.g. `(fail) … a 429 before any output is retried …`) before the retry branch.
  (`parseRetryAfter` negative case also red until the "-3 parses as a year" guard.)
- **Green:** `bun test packages/providers` → 66 pass, 0 fail.
- **Mutation:** `retryAfterMs ?? 0` → `0` in the delay: `retry-after longer than
  the backoff is honoured` fails (25 pass / 1 fail); restored from a `cp` backup,
  `shasum` identical (`35c393fe…`).
- **Gate:** `bun run lint` clean; `bun test packages` 3090 pass / 0 fail. The
  worktree has no `apps/mobile` deps (CI filters them out): full `bun test` shows
  3129 pass / 3 skip / 1 fail+1 error and `typecheck` shows 2 errors, ALL in
  `apps/mobile` (`expo/tsconfig.base`, `@tentacle/client` unresolved) — environmental,
  not from this change; `bun install` was not approved here so no pristine
  baseline was taken. `tsc -p apps/mobile` emitted stray `.js` files; deleted.
- **Drift:** none from the plan; the header param is typed structurally
  (`{ get(): string | null }`) because bun-types and DOM `Headers` differ.

## Review

*— claude-opus-5-5, 2026-10-26*

**Verdict: APPROVE-WITH-NITS** (mergeable as is; the nits are optional follow-ups).
Reviewed in a fresh context by a different model family than the executor (Sonnet).

**Gate (re-run by me, mobile deps now installed):** `bun run check` green —
typecheck (`tsc --noEmit && tsc -p apps/mobile`) 0 errors; `biome check .` 523
files, no fixes; `bun test` **3132 pass / 3 skip / 0 fail**, 11553 expect(), 3135
tests across 241 files. The 3 skips are the opt-in ones (AGENTS §6). `git status`
after the gate shows only the task's 4 files + this doc (no stray `.js` files).

**Scope:** exactly the row. The diff touches only `providers/src/{retry,openai-provider,anthropic-provider}.ts`
and `providers/test/retry.test.ts`. There is no protocol schema, persisted format
or §7 invariant in it. The new ctor arg is optional and trailing, so the
other `ModelRequestError` call sites (`anthropic-provider.ts:205,216,231`) are
unchanged. `ModelRequestError` is not serialised over RPC. The retry wraps the
laptop-side provider only (`select-provider.ts:48`), so "model stays on the
laptop" is unaffected.

**Premise table**

| Premise | Verdict |
|---|---|
| Context: a 429 passes through un-retried on `main` (only `TRANSIENT_CODES`) | TRUE — mutation 1 below (the status branch disabled = `main`'s behaviour) makes the 5 retry tests fail |
| `anthropic-provider.ts` / `openai-provider.ts` throw before any yield | TRUE (`anthropic-provider.ts:98-107`, `openai-provider.ts:151-159`; the stream loops come after) |
| `ModelRequestError` in `openai-provider.ts:38`, imported by Anthropic `:28` | TRUE |
| In-stream Anthropic error uses status 0 → never matched | TRUE (`anthropic-provider.ts:205`) |
| `RetryInfo.code` only logged (`cli/src/daemon-log.ts:78`) | TRUE — renders `model retry 1/2 after HTTP 429 (no event delivered yet, …), waiting …ms` |
| Retry tracks `emitted` | TRUE (`retry.ts:175-178`) |

**Mutations (§9), `cp` backup, `shasum` before/after identical `35c393fe…`:**
1. `retryableStatus` → `RETRYABLE_STATUSES.has(-1)` (= the old behaviour): **5 fail**
   (429 retried, 529 retried, retry-after honoured, shorter retry-after, exhausted → original).
2. Dropped `emitted ||` from the 429 rethrow (`retry.ts:197`): **1 fail** ("a 429
   after output started is never retried"). Together with the executor's
   `retryAfterMs ?? 0` mutation, every new behaviour is pinned.

**Attacks tried**
1. *Duplicate partial output:* a 429 after a `text` event is rethrown as is and
   the consumer sees only `"par"` (test + mutation 2). Holds.
2. *Abort during the wait:* e2e trace (real `OpenAIProvider`/`AnthropicProvider`
   via injected fetch → `RetryingModelProvider`, real `abortableSleep`,
   `retry-after: 5`, abort at 200 ms): both providers gave `calls 1`, `AbortError`
   after **201 ms**, and `onRetry` `{code:"HTTP 429", delayMs:5000}`. Holds. The
   existing test at `retry.test.ts:349` covers the shared sleep path.
3. *`retry-after` parsing* (`parseRetryAfter`, trace): `"0"`→0, `"30"`→30000,
   `" 2 "`→2000; `"1e5"`, `"Infinity"`, `"+3"`, `"0x10"`, `"-3"`→undefined
   (plain backoff); `"99999999999999999999"`→1e23 and a 2099 HTTP-date are huge, so
   the error surfaces at once (the cap). See N1 for `"foo 2099"`.
4. *Exhaustion / identity:* after 3 calls the same error object is rethrown
   (`toBe(limited)`), so its status and hint stay intact. Holds.
5. *Other statuses:* 400/401/500/503 still pass through after one call (existing test). Holds.
6. *Prior art:* nothing open on `retry.ts` or 429 in `TODO.md`, `docs/fix`,
   `docs/library-bugs.md` or `docs/eval`.

**Findings**
- **N1 (low)** `openai-provider.ts:66-67`: any value containing a letter goes to
  JSC's lenient `Date.parse`, so garbage such as `"foo 2099"` parses as a date
  (→ 2.3e12 ms) and counts as "too long". The 429 then surfaces at once instead
  of taking the plain backoff, which contradicts the failure mode "garbage →
  plain backoff". It fails loud, never wrong, and real servers don't send this.
  Optional fix: accept only an IMF-fixdate shape.
- **N2 (low, design)** `retry.ts:196`: a `retry-after` longer than 30 s is not
  capped to a 30 s wait: the error surfaces at once. This is what the plan
  designed ("would stall the turn"), and it is defensible: retrying early
  against a server that asked for an hour just burns attempts. It is not a
  "cap at 30 s", though: whoever expects that should know it.
- **N3 (nit, test gap)** there is no boundary test for `retryAfterMs === maxRetryAfterMs`
  (`>` vs `>=`, currently waited for), and no test for a 429 with no `retry-after`
  and `random: () => 1` at the backoff cap. The behaviour is obvious from the
  code, so this is not blocking.
- **N4 (nit, scope note)** Anthropic's in-stream `overloaded_error` (status 0) is
  still not retried, even before any delivered event. That is consistent with
  the plan's "pre-stream HTTP answer" scope. Worth a TODO line if overloads
  show up mid-SSE in practice.

**What holds:** pre-stream only; abort wins first and is prompt; bounded at 3
attempts; original error kept; both providers pass `retryAfterMs`; `onRetry` text
is coherent; the scope is clean.

**Executor behaviour:** honest and well scoped. It reported the red counts, a
real mutation with a shasum restore, and its environmental gate gap (mobile
deps) instead of claiming green. It cleaned up the stray `tsc` output. The doc's
line citations match the pre-diff code. Small weakness: the failure mode
"garbage → backoff" was asserted without checking a lenient `Date.parse` (N1).

> **Owner (2026-10-26):** merge approved; review nits carried as debt.
