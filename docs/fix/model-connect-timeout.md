# fix/model-connect-timeout — a model endpoint that never answers the SYN fails in 15 s

> **Status:** review
> **Branch:** `fix/model-connect-timeout`
> Type: fix · **Size:** M · **Blast:** load-bearing (every model call of every runtime goes through the wrapped `fetch`) · **Suited:** strong model executes; mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-11-04*

Owner, live 2026-11-04: the default endpoint `http://192.168.1.17:8080/v1` is on
a machine that is OFF — SYNs get no answer at all (no RST; curl exit 28 after
20 s). A turn (`tentacle run … "ciao"`, or a typed message) sits in "working"
for minutes.

Why minutes: Bun's `fetch` has no timeout option of its own (`bun-types`
`globals.d.ts` has `proxy?` but no timeout on `RequestInit`), so a dead host
fails only when the OS gives up — **75 s**, with `ETIMEDOUT` (Repro). And
`ETIMEDOUT` is on the retry allowlist (`packages/providers/src/retry.ts:27`,
`DEFAULT_MAX_ATTEMPTS = 3`), so the turn waits ≈ 3 × 75 s + backoff ≈ **3m 46s**
before any error.

**Owner decision:** a CONNECT timeout of ~15 s, then a clear error
(`model unreachable: 192.168.1.17:8080 did not answer in 15s`). It must never
cut a slow model: once the TCP connection is up, time-to-headers / first token /
thinking are unlimited. A refused connection already fails fast — keep it.
Constraints: laptop side, every provider, one seam; HTTPS and proxies must not
break; no silent multiplication by the retry; Esc aborts at once; config only
if trivial.

**Repro** (`.tentacle/tmp/model-connect-timeout/probe.ts`, Bun 1.4.3, run on
`main` `0bedfc8`, 2026-11-04, no `*_PROXY` set):

```ts
// Q1: does Bun fetch to a blackhole fail on its own, and when?
// Q2: does abort cut the connect wait at once?
// Q3: does a TCP probe (node:net) time out on a blackhole while connecting at
//     once to a server that delays its headers 30 s?
import { createServer, createConnection } from "node:net";

const t0 = () => performance.now();
const secs = (s: number) => ((performance.now() - s) / 1000).toFixed(2);

async function fetchFor(url: string, abortAfterMs?: number) {
  const s = t0();
  const ac = new AbortController();
  if (abortAfterMs) setTimeout(() => ac.abort(), abortAfterMs);
  try {
    const r = await fetch(url, { method: "POST", body: "{}", signal: ac.signal });
    console.log(url, "status", r.status, "after", secs(s));
  } catch (e) {
    const err = e as { name?: string; code?: unknown; message?: string };
    console.log(url, "error", err.name, err.code, JSON.stringify(err.message), "after", secs(s));
  }
}

function tcpProbe(host: string, port: number, ms: number): Promise<string> {
  const s = t0();
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(`timeout after ${secs(s)}`);
    }, ms);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(`connected after ${secs(s)}`);
    });
    sock.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(`error ${e.code} after ${secs(s)}`);
    });
  });
}

const slow = createServer((sock) => {
  sock.on("data", () => {});
  setTimeout(() => sock.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"), 30_000);
});
await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
const slowPort = (slow.address() as { port: number }).port;

console.log("bun", Bun.version);
console.log("--- tcp probe (15 s budget)");
console.log("10.255.255.1:8080", await tcpProbe("10.255.255.1", 8080, 15_000));
console.log("192.168.1.17:8080", await tcpProbe("192.168.1.17", 8080, 15_000));
console.log("127.0.0.1:1 (refused)", await tcpProbe("127.0.0.1", 1, 15_000));
console.log(`127.0.0.1:${slowPort} (slow headers)`, await tcpProbe("127.0.0.1", slowPort, 15_000));
console.log("--- fetch abort during connect (abort at 2 s)");
await fetchFor("http://10.255.255.1:8080/v1/chat/completions", 2000);
console.log("--- fetch refused");
await fetchFor("http://127.0.0.1:1/v1/chat/completions");
console.log("--- fetch slow headers (30 s) must succeed");
await fetchFor(`http://127.0.0.1:${slowPort}/v1/chat/completions`);
console.log("--- fetch blackhole, no abort (how long until Bun/OS gives up?)");
await Promise.all([
  fetchFor("http://10.255.255.1:8080/v1/chat/completions"),
  fetchFor("http://192.168.1.17:8080/v1/chat/completions"),
]);
slow.close();
```

```
bun 1.4.3
--- tcp probe (15 s budget)
10.255.255.1:8080 timeout after 15.00
192.168.1.17:8080 timeout after 15.00
127.0.0.1:1 (refused) error ECONNREFUSED after 0.00
127.0.0.1:54346 (slow headers) connected after 0.00
--- fetch abort during connect (abort at 2 s)
http://10.255.255.1:8080/v1/chat/completions error AbortError 20 "The operation was aborted." after 2.00
--- fetch refused
http://127.0.0.1:1/v1/chat/completions error TypeError ECONNREFUSED "ECONNREFUSED: Unable to connect. Is the computer able to access the url?" after 0.00
--- fetch slow headers (30 s) must succeed
http://127.0.0.1:54346/v1/chat/completions status 200 after 30.00
--- fetch blackhole, no abort (how long until Bun/OS gives up?)
http://192.168.1.17:8080/v1/chat/completions error TypeError ETIMEDOUT "ETIMEDOUT: Unable to connect. Is the computer able to access the url?" after 75.00
http://10.255.255.1:8080/v1/chat/completions error TypeError ETIMEDOUT "ETIMEDOUT: Unable to connect. Is the computer able to access the url?" after 75.00
```

Established: (1) Bun `fetch` exposes no connect-only timeout, and nothing tells
when its TCP connection is up; (2) a blackhole costs 75 s per attempt
(`ETIMEDOUT`, retried ×3 today); (3) an abort ends the connect wait at once;
(4) a raw `node:net` connect distinguishes "host answers" (0 s, even when the
HTTP server then holds its headers 30 s) from "host silent" (timer) and
"refused" (0 s) — it is the connect-only signal `fetch` lacks.

## Implementation

*— claude-opus-5-5, 2026-11-04*

### Load-bearing assumption

**Every model call on the laptop is a `fetch` made by a provider built by
`createModelProvider`, which can hand both providers one wrapped `fetch`.**
Proof: the only `new OpenAIProvider(` / `new AnthropicProvider(` in any `src/`
is `packages/providers/src/select-provider.ts:47`; both read `config.fetch ??
fetch` (`openai-provider.ts:133`, `anthropic-provider.ts:77`) and pass
`request.signal` in `init` (`openai-provider.ts:147`, `anthropic-provider.ts:94`);
the only `createModelProvider(` call in `src/` is
`packages/cli/src/model-provider.ts:21` (`configuredModelProvider`), which
serves the agent, the sub-agents' per-type models and the laptop side of the
pod tunnel (its doc comment, `model-provider.ts:1-6`). So wrapping `fetch`
there covers every provider and every runtime, pods included.

### Preconditions

- Abort during a Bun connect rejects at once (Repro, 2.00 s) — so the timer
  can end the wait by aborting, and Esc keeps working through the same signal.
- A pod sees a laptop model error only through `RemoteClient.connectionLost`
  (`packages/client/src/remote-client.ts:1859`), which today maps only
  `name === "ModelConnectionError"`; anything else becomes the peer's opaque
  "internal error" — and the message must not be forwarded as is (it names the
  laptop endpoint; the pod is not trusted, AGENTS §7).
- `RetryingModelProvider` retries only a string `code` on `TRANSIENT_CODES`
  or a retryable HTTP status, and rethrows anything else untouched
  (`retry.ts:181-186`).
- Bun honours `HTTP_PROXY`/`HTTPS_PROXY` (`bun-types` `globals.d.ts:899`); the
  repo sets no `proxy:` itself (grep: none in `packages/*/src`).

### Design

New `packages/providers/src/connect-timeout.ts`:

- `withConnectTimeout(inner: typeof fetch, { timeoutMs, probe, env })`
  returns a `fetch`. Per call: parse the URL's host and port (default 80/443,
  IPv6 brackets stripped); start `inner` with `AbortSignal.any([caller signal,
  own signal])`, and **in parallel** a TCP `probe(host, port, signal)` plus a
  `timeoutMs` timer.
  - probe connects → timer cleared; the request is unlimited from then on.
  - probe fails (refused, DNS) → timer cleared; `fetch` reports its own error
    (the refused fast path is untouched).
  - timer fires while `fetch` has not settled → abort it, throw
    `ModelUnreachableError` (`model unreachable: <host>:<port> did not answer
    in 15s`, `code: "ECONNTIMEOUT"`, the fetch error as `cause`).
  - `fetch` settles (headers or error) → timer cleared, probe aborted
    (socket destroyed); a timer firing after that changes nothing.
  - the caller aborts → `fetch` rejects with its `AbortError` at once (as
    today); timer and probe are cleaned up.
- **Proxy:** when any of `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (either case)
  is set, the wrapper passes through without a probe — the TCP peer would be
  the proxy, and `NO_PROXY` matching is Bun's, not ours. Fail-open = today's
  behaviour, never a false timeout.
- `defaultTcpProbe`: `node:net` `createConnection`, resolve on `connect`,
  reject on `error`, destroy on abort/settle. TLS is not involved: the probe
  measures the TCP handshake only, so HTTPS works unchanged.
- `createModelProvider` (`select-provider.ts`) wraps the fetch it hands the
  providers: options `connectTimeoutMs?` (default `DEFAULT_CONNECT_TIMEOUT_MS
  = 15_000`) and `connectProbe?` (tests). An injected `fetch` with no injected
  `connectProbe` is NOT wrapped: a test fetch has no TCP connection to time,
  and the default probe would hit the network.
- **Retry:** `ECONNTIMEOUT` is deliberately NOT on `TRANSIENT_CODES`, so
  `RetryingModelProvider` rethrows it untouched: one 15 s wait, then the error.
  A dead host is not a blip (TCP already retransmits the SYN inside the 15 s).
  No change to `retry.ts` except its doc comment.
- **Pod:** `connectionLost` also maps `name === "ModelUnreachableError"` to a
  text built from the code only: `model unreachable: the model endpoint did not
  answer (ECONNTIMEOUT)` — no host to the pod.
- **Config:** none. Recommendation: keep 15 s fixed; if a user ever needs it,
  `model.connectTimeoutMs` would thread through `configuredModelProvider` in
  one line (the option already exists on `createModelProvider`).

### Files

1. `packages/providers/src/connect-timeout.ts` (new) + export in `index.ts`.
2. `packages/providers/src/select-provider.ts` — wrap the fetch.
3. `packages/providers/src/retry.ts` — doc comment only.
4. `packages/client/src/remote-client.ts` — `connectionLost` maps the new error.
5. Tests: `packages/providers/test/connect-timeout.test.ts` (new),
   `packages/client/test/remote.test.ts` (one case).

### Failure modes

- **Slow model** (headers after minutes): probe connects at once → timer
  cleared → never cut. Pinned by a test (fetch held past the timeout).
- **Refused:** probe rejects at once, fetch rejects `ECONNREFUSED` at once →
  retried as today (allowlisted), fast.
- **Esc during the wait:** caller signal aborts fetch at once; error is the
  `AbortError`, not `ModelUnreachableError`; probe socket destroyed.
- **Retry:** `ECONNTIMEOUT` not retried — total ≈ 15 s, one error.
- **Proxy set:** no probe, no timeout (today's behaviour). Debt, stated.
- **DNS hangs:** the probe resolves the same name → counts against the 15 s →
  reported as unreachable (correct: nothing answered).
- **Keep-alive + a server whose accept backlog is full:** fetch may run on a
  pooled live connection while a NEW probe SYN is dropped → a false timeout of
  a slow-to-header request. Requires a saturated listen backlog; accepted,
  stated. (A probe that succeeds the normal way leaves no such risk.)
- **Timer vs headers race:** if the timer fires first we aborted the request;
  the call reports `ModelUnreachableError` even if a `Response` arrives in the
  same tick — consistent, never a half-aborted body handed on.
- **Extra connection:** each model call opens one extra TCP connection that
  closes without sending a byte (server sees accept + EOF). Harmless for
  llama.cpp/vLLM/cloud; noted.

### Tests

`connect-timeout.test.ts` (fake `fetch` honouring the signal, fake probe; no
network; small timeouts):
1. silent probe + hanging fetch → `ModelUnreachableError` with
   `host:port did not answer in Ns`, within ~timeout.
2. probe connects, fetch answers after > timeout → the Response, no error
   (the "never cut a slow model" property).
3. probe refused → fetch's own error passes through, not converted.
4. caller abort during the wait → rejects at once with the abort, not the
   unreachable error; the probe's signal is aborted.
5. proxy env set → no probe called, no timeout.
6. https URL without port → probe gets port 443; IPv6 host unbracketed.
7. via `createModelProvider` (both providers): the timeout surfaces as the
   stream's error after ONE fetch (no retry).
`remote.test.ts`: a laptop `ModelUnreachableError` reaches the pod turn as
`model unreachable … (ECONNTIMEOUT)` without the host.
Each red first; one mutation per behaviour, reverted (shasum).

## Execution

*— claude-opus-5-5, 2026-11-04*

As built, in order:

1. **Red.** `connect-timeout.ts` first as a pass-through stub (`withConnectTimeout`
   returned `inner`), wired in `select-provider.ts`, plus
   `test/connect-timeout.test.ts`. `bun test packages/providers/test/connect-timeout.test.ts`
   → **5 fail / 3 pass**, every fail an assertion: the timeout case got
   `"hung"` (the `settle` helper races 2 s so a missing timeout fails on an
   assertion, not a test timeout), the cancel case `probe signal aborted:
   undefined`, the host/port case a mismatched list, both `createModelProvider`
   cases `"hung"`. The 3 that passed are "must NOT cut" guards (slow, refused,
   proxy), green on any implementation that does nothing; they are proven by
   mutation (M1, M2, M5 below).
2. **Green.** Implemented `withConnectTimeout` + `defaultTcpProbe` +
   `ModelUnreachableError` (`packages/providers/src/connect-timeout.ts`);
   `createModelProvider` wraps the providers' fetch
   (`select-provider.ts:42-50`); exported from `index.ts`; doc note in `retry.ts`.
3. **Pod mapping.** `RemoteClient.connectionLost`
   (`packages/client/src/remote-client.ts:1859-1880`) also accepts
   `ModelUnreachableError` → `model unreachable: the model endpoint did not
   answer (ECONNTIMEOUT)`; new test in `packages/client/test/remote.test.ts`.
   Its red is mutation C1 below (the original line): `Received: "internal error"`.
4. **Loopback end-to-end test** (real `fetch` + real `defaultTcpProbe`, server
   holds headers 300 ms past a 50 ms timeout → the body `ok` arrives).
5. **Live check after the fix** (`.tentacle/tmp/model-connect-timeout/live.ts`,
   the real `createModelProvider`, default 15 s, no fakes):

   ```
   http://192.168.1.17:8080/v1 ModelUnreachableError ECONNTIMEOUT "model unreachable: 192.168.1.17:8080 did not answer in 15s" after 15.01 retries []
   http://10.255.255.1:8080/v1 ModelUnreachableError ECONNTIMEOUT "model unreachable: 10.255.255.1:8080 did not answer in 15s" after 15.00 retries []
   http://10.255.255.1:8080/v1 AbortError 20 "The operation was aborted." after 2.00 retries []
   http://127.0.0.1:1/v1 ModelConnectionError ECONNREFUSED "could not connect to the model endpoint (ECONNREFUSED), gave up after 3 attempt(s): …" after 1.21 retries [ "ECONNREFUSED", "ECONNREFUSED" ]
   ```

   Dead host: 15 s, one error, no retry (was ≈ 3m 46s). Esc at 2 s: 2.00 s.
   Refused: unchanged (fast, retried as before).

**Mutations** (one per behaviour, each reverted; `shasum` of
`connect-timeout.ts` `140f3910…`, `retry.ts` `189bc66c…`, `remote-client.ts`
`490efae7…` identical after the reverts):

| # | Mutation | Failed |
|---|---|---|
| M1 | probe connected does not clear the timer | "slow answer never cut" + loopback "holds its headers" |
| M2 | probe refused does not clear the timer | "refused probe leaves the fetch alone" |
| M3 | caller's signal not linked into the fetch | "cancel during the connect wait aborts at once" |
| M4 | timer sets `timedOut` but does not abort | "never answers … fails after the timeout" + both `createModelProvider` cases |
| M5 | proxy env ignored | "with a proxy configured there is no probe" |
| M6 | https default port 80 | "probe dials the URL's host and port" |
| M7 | `ECONNTIMEOUT` added to `TRANSIENT_CODES` | both `createModelProvider` cases (got a `ModelConnectionError` after 3 attempts) |
| C1 | `connectionLost` ignores `ModelUnreachableError` (= `main`) | pod test: `Received: "internal error"` |
| C2 | pod text appends the laptop message | pod test: `Expected to not contain: "192.168.1.17"` |

**Drift from Implementation:**
- The wrapper first also registered an abort listener on the caller's signal
  to stop the probe; removed as redundant. The caller's abort reaches `inner`
  through the linked signal, and the `finally` stops the probe. M3 was run
  after this change.
- After the mutations, `tsc` refused `AbortSignal.any` (not in the repo's TS
  lib) and `let url: URL = new URL(…)` (DOM/Bun `URL` type clash). Fixed with
  a typed cast wrapper `anySignal` (Bun has it at runtime, as the green tests
  show) and `URL.canParse`. Neither changes behaviour; the narrow suites were
  re-run green.
- **Not planned:** two existing loopback tests counted TCP *connections*
  (`packages/providers/test/select-provider.test.ts` `flakyEndpoint`,
  `packages/cli/test/model-provider.test.ts` `resetOnce`). The real probe is
  one extra connection with no bytes, so they saw 4 instead of 2. Both now
  count on the first byte, which is what they mean (requests). This is the
  "extra connection" failure mode, seen in practice.

**Gate** (2026-11-04): `bunx tsc --noEmit` clean · `bunx biome check .` clean
(613 files) · `bun test packages` **4219 pass / 3 skip / 0 fail** (main
baseline 4209 / 3 / 0; +10 = 9 in `connect-timeout.test.ts` + 1 in
`remote.test.ts`).

## Review

*— claude-opus-5-5, 2026-11-04 (fresh-context adversarial review; SAME model as
the executor — only the context is fresh, so shared blind spots may survive
both passes; AGENTS §10 would prefer a different model for load-bearing)*

**Verdict: PASS (APPROVE-WITH-NITS).** No HIGH/MEDIUM finding; the LOW ones
below do not block.

**The property, proven empirically** — real `createModelProvider`, default
15 s, real `fetch` + real `defaultTcpProbe`, no fakes, no `*_PROXY` set
(`.tentacle/tmp/model-connect-timeout/review/e2e.ts`, all runs in parallel):

```
https real            ERR ModelRequestError (401 from api.anthropic.com) after 0.25 retries []
refused               ERR ModelConnectionError ECONNREFUSED … gave up after 3 attempt(s) after 0.88 retries [ECONNREFUSED, ECONNREFUSED]
blackhole esc@2s      ERR AbortError after 2.00 retries []
blackhole openai      ERR ModelUnreachableError ECONNTIMEOUT "model unreachable: 10.255.255.1:8080 did not answer in 15s" after 15.00 retries []
blackhole anthropic   ERR ModelUnreachableError ECONNTIMEOUT "… did not answer in 15s" after 15.00 retries []
slow 1st token 35s    OK text="ok" after 35.01   (headers at once, first SSE chunk after 35 s)
slow headers 35s      OK text="ok" after 35.01   (headers + body after 35 s)
localhost->v4-only 35s OK text="ok" after 35.01  (dual-stack name, server on 127.0.0.1 only)
server accepts 6 (3 probes + 3 requests) · process exit lag after last op 0.00 s
```

Quick variant (`… e2e.ts quick`): Esc at 1 s on a connected slow server →
`AbortError` after 1.00; server-side open sockets 0 within 500 ms (probe and
request both closed). Exit lag 0.00 in the full run = no wrapper timer or
connecting socket keeps the loop alive (a leaked blackhole probe would hold it
up to 75 s). `family.ts`: Bun's `node:net` `getDefaultAutoSelectFamily()` is
`true` and a v6-only listener is reached via `localhost` — the probe does
happy-eyeballs like `fetch`, so a dual-stack name does not false-time-out.

**Gate** (re-run by me): `bunx tsc --noEmit` clean · `bunx biome check .`
clean (613 files) · `bun test packages` **4219 pass / 3 skip / 0 fail**
(4222 tests, 287 files) — matches Execution.

**Mutations** (each reverted; `shasum` of every changed/untracked file
identical before/after):

| # | Mutation | Result |
|---|---|---|
| M1 (claimed) | probe connect does not clear the timer | FAIL: "slow answer never cut" + loopback "holds its headers" ✔ |
| M7 (claimed) | `ECONNTIMEOUT` on `TRANSIENT_CODES` | FAIL: both `createModelProvider` cases (`ModelConnectionError … 3 attempt(s)`) ✔ |
| R1 (mine) | proxy check ignores lowercase `http_proxy` | FAIL: "with a proxy configured there is no probe" ✔ |

**Premise table**

| Premise | |
|---|---|
| Symptom: blackhole costs 75 s/attempt, `ETIMEDOUT` retried | TRUE (Repro; `retry.ts:29` today, `:27` on main) |
| Only provider construction: `select-provider.ts` (main `:47`, now `:67`) | TRUE (grep `new (OpenAI\|Anthropic)Provider(` in `src/`) |
| Both read `config.fetch ?? fetch` (`openai-provider.ts:133`, `anthropic-provider.ts:77`) and pass `request.signal` (`:147`, `:94`) | TRUE |
| Only `createModelProvider(` call: `cli/src/model-provider.ts:21` | TRUE; all model sites (`engine-runtime.ts:99,105`, `wiring.ts:280,384,445`) go through `configuredModelProvider` |
| Pod model errors pass `RemoteClient.connectionLost` (`remote-client.ts:1859`) | TRUE; only pods pass `modelProvider` to `RemoteClient` (`local-runtime.ts:532`), the in-process worker builds its own via `wiring.ts` |
| Retry rethrows non-allowlisted codes untouched (`retry.ts:181-186`) | TRUE (`:183-186` after the +2 doc lines) |
| No `proxy:` set in `packages/*/src` | TRUE (grep) |

**Attacks tried**
1. *Slow server cut?* Headers at 35 s and first token at 35 s, real stack → not cut (above). Nothing found.
2. *Other model `fetch` outside the seam?* grep of `fetch(` in `packages/*/src`: only providers (via `config.fetch`), MCP HTTP, k8s. Nothing found.
3. *Dual-stack / broken family → probe stuck while fetch connected → false cut?* Bun `net` autoSelectFamily = true (above). Nothing found; a truly blackholed IPv6 was not reproducible here (see unverified).
4. *Leaks after success / abort* — exit lag 0.00, sockets closed. Nothing found.
5. *Retry multiplication* — 1 fetch, `retries []`, 15.00 s; refused still retried fast. As documented.
6. *Pod leak of the endpoint* — pod text is code-only; C1/C2 in Execution cover it. Nothing found.

**Findings** (all LOW)
1. LOW `packages/providers/src/connect-timeout.ts:129,149` — a `Request`
   input carrying its own `signal` (and no `init.signal`) loses it: `{...init,
   signal}` overrides the Request's signal, so its abort would not reach the
   fetch. Unreachable today (both providers call `fetch(url, init)`), but the
   wrapper is exported as a general `fetch`.
2. LOW `connect-timeout.ts` design — the probe and the request resolve DNS
   independently: with a round-robin name where one A record is dead, the
   probe may connect to a live address while `fetch` hangs on the dead one →
   no timeout (back to 75 s × 3). Fail-open, not a false cut. Not in Failure
   modes; worth one line there.
3. LOW `docs/fix/model-connect-timeout.md` Execution — the post-mutation
   shasums are stale (`connect-timeout.ts` `140f3910…` / `retry.ts`
   `189bc66c…` vs the tree's `b7815ebb…` / `34408d1c…`); explained for
   `connect-timeout.ts` by the tsc drift, not stated for `retry.ts`.
4. LOW `packages/client/test/remote.test.ts` (new case) — asserts only
   `seen.length > 0`, not that the laptop's `onError` got the full
   `ModelUnreachableError` with the host (the "laptop keeps the full error"
   claim in the comment).

**Unverified:** a real blackholed-IPv6 dual-stack host (needs a broken-v6
network); a proxy run end to end (unit-tested only). How to verify: point the
model at a host with a dead AAAA + live A and a server that holds headers
> 15 s; expect success.

**Executor behaviour:** disciplined. Red-first was real (5 assertion fails,
with the 3 "must not cut" guards honestly called out as vacuous until
mutated), drift recorded (the two connection-counting tests, the tsc casts),
live run on the owner's real dead host. Only sloppiness: stale shasums
(finding 3). Did not claim the fresh-context review as done.

**Owner-level questions**
1. Proxy: with any `*_PROXY` set there is NO connect timeout (fail-open).
   Accept, or implement Bun-compatible `NO_PROXY` matching and probe the proxy?
2. One extra TCP connection (accept + EOF) per model call: acceptable for your
   endpoints (any that log/rate-limit connections)?
3. 15 s fixed, no config key: OK, or expose `model.connectTimeoutMs` now?
4. Pod runs show `model unreachable: the model endpoint did not answer
   (ECONNTIMEOUT)` — no host and no "15s". Acceptable, or should the laptop TUI
   show the full laptop-side message (it has it via `onError`)?
5. Accept the theoretical false cut (keep-alive request waiting headers while
   the server's listen backlog drops the probe's SYN for 15 s)?

### Executor self-review (superseded by the Review above)

*— claude-opus-5-5, 2026-11-04 (in-context self-review — NOT the mandatory fresh-context one)*

Blast is load-bearing, so AGENTS §10 requires a **fresh-context** Review
(a sub-agent or `/code-review`). It was not run in this task: it is pending,
and this section is only the implementer's red-team, to be replaced or
confirmed.

What holds (evidence above): a dead host fails in 15 s with the owner's
message, and is not retried. A slow server, once TCP-connected, is not cut
(fake + loopback + M1). Refused stays fast. Esc aborts at once. Pods get a
named cause without the laptop endpoint (C1/C2). One seam covers both providers
and every runtime, because `createModelProvider` is the only construction site.

Open / for the owner:
- **Proxy:** with any `*_PROXY` set there is NO connect timeout (fail-open,
  today's behaviour). Probing the proxy instead would need our own `NO_PROXY`
  logic to match Bun's. Accept, or ask for it?
- **Extra TCP connection per model call** (accept + EOF, no bytes). Harmless
  for llama.cpp / vLLM / cloud. A server that logs or rate-limits connections
  would see it.
- **False timeout, theoretical:** a keep-alive request still waiting for its
  headers on a server whose listen backlog is full, so the new probe SYN is
  dropped for 15 s.
- **Config:** none added. `connectTimeoutMs` exists on `createModelProvider`;
  a `model.connectTimeoutMs` setting would be a one-line thread through
  `configuredModelProvider`. Recommended: not until someone needs it.
- Unverified: HTTPS against a real TLS endpoint was not exercised live. The
  probe is TCP-only and the URL tests pin port 443. To verify, run `live.ts`
  against `https://api.anthropic.com/v1`: expect an HTTP error, not a timeout.

### Execution — round 2

*— claude-sonnet-5-5, 2026-11-04*

**Owner decisions on the Review's questions** (live test 2026-11-04, all 4
checks as expected): Q1 proxy fail-open **accepted**; Q2 the extra TCP probe
**accepted**; Q3 **no config key**; Q5 the theoretical false cut **accepted**;
**Q4: a pod run shows the SAME full message as a local run**
(`model unreachable: 192.168.1.17:8080 did not answer in 15s`), but the laptop
must not send the endpoint into the pod (§7).

**Q4 design — the host never leaves the laptop.** The pod still gets only
`model unreachable: the model endpoint did not answer (ECONNTIMEOUT)` (built
from the code in `connectionLost`). The laptop's `RemoteClient` — which owns
the model link and so already holds the full `ModelUnreachableError` — records
`pod-safe text → full message` in a laptop-only map (`laptopTexts`), and
`RemoteClient.laptopText()` swaps it back in where the turn's error is built
for the laptop's TUI (`RemoteSession.end`, `remote-session.ts`, the single place a
`turn_end{error}` becomes the thrown `RpcError`). Display only: nothing of it
is on the wire or in the pod's history (the pod's persisted record keeps the
safe text). A pod cannot forge a display of anything the laptop did not
itself raise: only a text the laptop produced is a map key. Files:
`remote-client.ts` (map + `laptopText`), `remote-session.ts` (one call).

**Red first.** `remote.test.ts` "the pod never receives the endpoint; the
laptop's turn error shows it": `clientCh.send` is wrapped to log every frame the
laptop sends toward the pod; asserts (a) the turn error `toBe` the full
local-run message, (b) no sent frame contains `192.168.1.17`, (c) `onError` got
the full error. Red on the assertion: `Received: "model unreachable: the model
endpoint did not answer (ECONNTIMEOUT)"`. Green after the change.

**Mutations** (one per behaviour; reverted; shasum identical after,
`remote-client.ts` `5bee1469…`, `remote-session.ts` `cac33298…`):

| # | Mutation | Failed |
|---|---|---|
| N1 | `RemoteSession.end` does not call `laptopText` | (a): `Received: "…the model endpoint did not answer (ECONNTIMEOUT)"` |
| N2 | `connectionLost` appends `error.message` to the pod text (host leaks) | (a) fails with the doubled text; the same leak also fails (b), the wire check |

(The first attempt at N1/N2 ran with its backup copies failing to write; the
files were restored by inverting each `sed` and the shasums above confirm the
identity with the pre-mutation tree.)

**Review LOWs fixed.** (4) weak test: now asserts the full error with the host
reached `onError` (above). (3) stale shasums: the final `connect-timeout.ts` is
`b7815ebb…`, `retry.ts` `34408d1c…` (the `140f3910…`/`189bc66c…` in Execution
are pre-drift; `connect-timeout.ts` changed by the `anySignal`/`URL.canParse`
fix, `retry.ts` by its doc-comment lines added after the first hash). Review
LOW 1 (a `Request` input's own signal) and LOW 2 (probe and request resolve
DNS independently, so one dead A record can leave the old 75 s: fail-open, not
a false cut) stay as stated debt, unchanged.

**Gate** (2026-11-04): `bunx tsc --noEmit` clean · `bunx biome check .` clean
(613 files) · `bun test packages` **4219 pass / 3 skip / 0 fail** (the case
was edited in place, so the count is unchanged).

## Review — round 2

*— claude-opus-5-5, 2026-11-04 (fresh-context reviewer of round 1; round 2
executed by claude-sonnet-5-5, so this round has a different-model pair)*

**Verdict: PASS.** LOW findings only.

**Q4, end to end with a REAL error** (not the test's hand-built object):
`.tentacle/tmp/model-connect-timeout/review/q4-wire.ts` — the real
`createModelProvider` (`connectTimeoutMs: 300`, real probe, real Bun `fetch`,
real `cause`) behind `RemoteClient`, a real `SessionHost` + `ProxyModelProvider`
as the pod, every frame logged in BOTH directions, two turns:

```
turn 1 laptop shows: "model unreachable: 10.255.255.1:8080 did not answer in 0.3s"
turn 2 laptop shows: "model unreachable: 10.255.255.1:8080 did not answer in 0.3s"
onError (laptop log): [ModelUnreachableError: … 10.255.255.1:8080 … ×2]
frames laptop→pod: 6 with host: 0
frames pod→laptop: 10 with host: 0
pod agent state has host: false
laptop→pod error frames: {"jsonrpc":"2.0","id":"1","error":{"code":-32603,"message":"model unreachable: the model endpoint did not answer (ECONNTIMEOUT)"}}  (and id 2, same)
```

The only error frame the pod receives is the code-only text; there is no
`data`/`cause` member. The swap happens on the laptop
(`remote-session.ts:1305`, `RemoteSession.end` → `RemoteClient.laptopText`,
`remote-client.ts` `laptopText`) after the pod's `turn_end{error}` arrives, and
nothing sends its output back to the pod.

**Other model errors unchanged.** My mutation R2 (mine): the `laptopTexts.set`
runs for EVERY `ModelConnectionError` (guard `e.name === "ModelUnreachableError"`
→ `true`). `remote.test.ts` "a lost laptop model mid-reply" FAILS with
`Received: "ECONNRESET: socket closed by http://10.0.0.5 key=sk-X"`. So other
errors keep their pod-safe text, and that test pins it. The mutation also shows
why the guard matters: a `ModelConnectionError` message can carry secrets. I
reverted it, and the `shasum` of every changed/untracked file was identical
before and after.

**Gate** (once, foreground): `bunx tsc --noEmit` clean · `bunx biome check .`
clean (613 files) · `bun test packages` **4219 pass / 3 skip / 0 fail**
(4222 tests).

**Attacks tried**
1. *Host on the wire, real error with `cause`, 2 turns, both directions* —
   0 frames (above). Nothing found.
2. *Pod forges the safe text in a later `turn_end`* — the laptop then shows its
   OWN last endpoint message, on the laptop. That is a wrong display, not a
   leak, and it never creates an approval. Accepted (LOW 1).
3. *Other model errors swapped/leaked* — R2 above. They are not.
4. *Swapped text flowing back* — `laptopText` is called only at
   `remote-session.ts:1305` (grep), and the result goes to `turn.queue.fail`.
   Nothing found.

**Findings** (all LOW)
1. LOW `remote-client.ts` `laptopTexts` — the map has one key, and its value
   is the LAST message. It is never cleared. After one real timeout, a pod
   can make the laptop show that endpoint text for any later turn by sending
   the same safe string. This is display only, with laptop-owned data.
2. LOW scope of Q4 — the swap lives in the `RemoteClient` that served the
   failing model call. Another laptop process attached to the same pod session
   (a second TUI of a detached run, a later `attach`, history replay from the
   pod's record) shows the pod-safe text `model unreachable: the model
   endpoint did not answer (ECONNTIMEOUT)`. This is expected from the design
   (the pod keeps only the safe text), but it is not "same as local" there.
3. LOW (carried from round 1, accepted debt): `Request` input signal; DNS
   round-robin fail-open.

**Owner-level questions:** none new. Optional: is finding 2 (only the TUI
that served the call shows the host) acceptable?

**Executor behaviour (round 2):** good. Red was shown on the assertion. N1/N2
target the two halves of the property. The botched `sed` backups were disclosed
and the shasums were re-verified. The round-1 LOWs 3 and 4 are fixed, and 1
and 2 are stated as debt.
