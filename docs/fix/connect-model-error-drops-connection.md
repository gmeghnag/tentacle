# fix/connect-model-error-drops-connection

> **Status:** review
> **Branch:** `fix/connect-model-error-drops-connection`
> **Size:** M · **Blast:** load-bearing · **Suited:** DeepSeek exec, one Opus review

## Context

*— deepseek (tentacle --profile deepseek), 2026-11-10*

Owner, live: `tentacle connect ws://192.168.1.17:4000` against a `serve` daemon on
another host. Two reports, one evening:

1. **A 401.** The serve daemon's own config had no model (`model = {}` → the
   default endpoint/model, no key), so the provider answered
   `401 Invalid API Key`. The TUI showed only `RPC connection error`; the daemon
   logged `error: model request failed with status 401 …` and then
   `connection-close`.
2. **An engine restart.** The inference engine behind the serve's model was
   restarted mid-session → "rpc error", and *every* later send kept failing even
   after the engine was back; only Ctrl+C + a new `tentacle connect` worked.

### Evidence (measured on this branch, real `startDaemon` + real `RemoteClient`)

All repros live in `packages/cli/test/connect-model-error.test.ts` (the stack is
the real one: a real `Bun.serve` OpenAI-compatible endpoint that fails and then
recovers, `startDaemon`'s real WebSocket server, the real `RemoteClient` with its
real reconnect factory). The TUI frames come from
`packages/tui/test/connect-model-error.test.tsx` (the real `App`).

**R1 — a 401 is a failed turn, and the link survives.**
`1 pass` today *except* the message: the turn ends with `internal error`, and the
**next send on the same session works** (`{"texts":["recovered"],"error":null}`).
So the connection is NOT dropped by a model error; what the owner saw was the
redacted message plus the daemon's own `connection-close` audit line, which is
the client's ordinary socket close at quit. **The visible defect for (a) is the
message.**

**R2 — the redaction, by source.** `packages/daemon/src/hosted-session.ts:341-348`
(`redactTurnError`): a non-`RpcError` turn failure becomes
`{ message: "internal error" }` unless `exposeTurnErrors` is set.
`packages/cli/src/worker.ts:118` sets it (the in-process worker: the model is
local); `packages/cli/src/serve.ts` (`reloadedHost`, the `SessionHost` literal at
`:178-200` and the pod host at `:508`) never does. AGENTS §7 is explicit that a
`serve` daemon's host is **the user's own machine** (it is the only daemon that
persists for that reason) — so a client connected to it is local-and-trusted in
exactly the sense the flag was written for. A pod daemon is not, and keeps the
redaction.

**R3 — a hung model call wedges the turn for ever (the "engine restart").**
An endpoint that accepts the connection and sends *no byte* (what a restarting
engine does: the socket is up, the model is loading) is not covered by any
timeout: `connect-timeout.ts` only bounds the TCP SYN phase
(`DEFAULT_CONNECT_TIMEOUT_MS`, and its own docs say a connected-but-silent
server is not its business), the provider has no first-byte/idle bound
(`packages/providers/src/retry.ts` retries only statuses and connection *codes*),
and `RpcPeer` has no `requestTimeoutMs` on this path. Measured: the TUI frame
stays `⠼ Working… 36s · esc/ctrl+c to stop` indefinitely, every later typed
message is **queued** (`ctrl+x ctrl+s to send now`) and never runs. That is the
owner's "only Ctrl+C worked" — the turn never ends, so nothing behind it runs.

**R4 — a turn can be ORPHANED, and then every later send fails (the exact
second-repro shape).** When a send is issued while the link is down, the daemon
may later accept it (the client re-sends keyed commands, `sessionCall`); a send
issued meanwhile is refused by the daemon with `TurnInProgress`. Measured frame
trace (`probe-frames`): the daemon correctly runs and ends **both** turns
(`turn_start cfdc34ab` … `turn_end cfdc34ab`), and the second send is refused
`-32004 a turn is already running` — yet the first turn's generator **never
settles** (still waiting after 10 s) and the daemon reports
`running: false`. Root cause: `packages/client/src/remote-session.ts:1105`
(`runTurn`) assigns `this.active = turn` unconditionally, so the turn that was
already in flight is no longer `this.active`; `turnFor`
(`remote-session.ts:1261-1268`) only searches `[settling, active, next, foreign]`,
so that turn's `turn_end` finds no owner and is dropped (`route:1474-1482`), and
its `AsyncQueue` is never closed. The client is then permanently "running" a
turn nothing can end: every later send is either queued behind it (TUI) or
refused, for the life of the process.

**R5 — the link DOES reconnect, and the same session comes back** (so (b) needs
no new mechanism, only a statement of fact and one regression test): after
`daemon.stop()` + a new daemon on the same port, the client re-dials (bounded
backoff, `link-machine.ts`), re-opens the SAME session id (`session/open
{sessionId, since}`), takes the resync, and the turn that was in flight completes
(`{"two":"ok: answer2","three":"ok: answer3"}`). The StatusBar already shows
`reconnecting… (attempt N, retry in Ns) — …`. What the TUI CANNOT do today is
recover from R3/R4, because those are not link states.

### Repro

The two measured shapes, as they stand on `main` (each is now a test in
`packages/cli/test/connect-model-error.test.ts`; the frame trace is from a
throwaway probe in `.tentacle/tmp/connect-model-error/`, run 2026-11-10):

**R3 — a hung model call, seen from the TUI** (a `Bun.serve` that accepts the
connection and sends nothing, then `mode = "ok"`; the real `App`):

```
HUNG    >>> "… › first  ⠼ Working… 1s · esc/ctrl+c to stop … ❯  Queue a task…"
SECOND  >>> "… › first  › second  ctrl+x ctrl+s to send now  ⠏ Working… 4s …"
LATER   >>> "… ⠧ Working… 12s · esc/ctrl+c to stop …"
AT+34s  >>> "… ⠋ Working… 36s · esc/ctrl+c to stop …"   ← for ever
```

**R4 — the orphaned turn, seen on the wire** (a scripted `send` while the link
is down, then a second `send`; frames logged at the channel):

```
>> session/prompt turnId=cfdc34ab "two"
>> session/prompt turnId=a5bbe01e "three"
<< turn_start cfdc34ab
<< {"id":4,"result":{"turnId":"cfdc34ab"}}
<< {"id":5,"error":{"code":-32004,"message":"a turn is already running"}}
<< turn_end cfdc34ab                     ← the daemon ENDED it
   (turn "two" never settles: no owner, its queue is never closed)
```

**The 401's message**, before and after (same stack, same scripted endpoint):

```
before: MEASURE first: internal error | second: {"texts":["recovered"],"error":null}
after : first: model request failed with status 401: Invalid API Key
```

### Context — root causes (one line each)

1. **The message was redacted by design, for the wrong host.** `redactTurnError`
   (`hosted-session.ts:341`) returned `"internal error"` because `serve` never
   set `exposeTurnErrors` (only `worker.ts:118` did) — though the serve host is
   the user's own (AGENTS §7).
2. **A second send orphaned the turn in flight.** `remote-session.ts` `runTurn`
   assigned `this.active` unconditionally, so the earlier turn lost its owner,
   its `turn_end` found nobody (`turnFor` searches a fixed list), and its
   `AsyncQueue` never closed — every later send then queued or was refused, for
   the life of the process. That is the owner's "only Ctrl+C worked".
3. **A connected-but-silent model has no bound** (`connect-timeout.ts` stops at
   the TCP SYN; the provider has no first-byte timeout), so the turn before a
   restarting engine stays `Working…` indefinitely. Esc escapes it; the turn
   itself cannot end until the model answers.
4. **The link was never the problem.** It reconnects (bounded backoff), re-opens
   the same session id, resyncs and runs the next send — measured. The daemon's
   `connection-close` audit line the owner saw is the ordinary socket close at
   quit, not a model error dropping the link.

### The decisions this task makes


- **(a)** A `serve` daemon exposes a model error's **message**, because its host
  is the user's own. Not raw: bounded and sanitized (see Implementation §3), and
  never for a pod daemon (its `SessionHost` stays redacting — a pod is not
  trusted, AGENTS §7).
- **(b)** Reconnect already works and is kept as is (a regression test now pins
  it). The real "never recovers" defect is R4, an **orphaned turn**, and that is
  what gets fixed: a turn already in flight is never clobbered; a second `send`
  is refused locally with the same `TurnInProgress` the daemon would give, and
  the in-flight turn keeps its owner and ends normally.
- **(c)** The failed-turn notice names whose model it was: on a remote
  (`model: "remote"`) session, a model-error notice carries the hint that the
  daemon uses ITS OWN model config (`tentacle config` on that host).
- **(d)** `serve` says at start-up when no model is configured — one line, before
  listening, through the existing `onNotice` sink.
- No `PROTOCOL_VERSION` bump: no wire schema changes. `turn_end.error.message`
  already carries a string; only *whose* string it is changes, and it is already
  documented as redactable (`packages/protocol/src/session.ts:224`).

### Preconditions (verified here)

- `redactTurnError` is the single place a turn failure is worded for the wire
  (`hosted-session.ts:341`, called at `:2240`); `TurnErrorPolicy` is passed
  through `SessionHost` (`session-host.ts:951-959`), so a `serve`-only flag is a
  one-line change.
- `startDaemon` builds the ONLY persistent `SessionHost`
  (`serve.ts:178`) and `podSessionHost` the pod one (`serve.ts:508`) — the trust
  split is already structural.
- `runTurn`/`turnFor`/`route` are the client's single turn-ownership path;
  `sendNow` already refuses a second wait (`remote-session.ts:956-961`), so a
  local `TurnInProgress` for a second `send` is consistent with it.
- TUI failure rendering goes through `failTurn` (`packages/tui/src/state.ts:251`)
  from one place (`App.tsx:1999`), and `App` already knows a remote session
  (`model === "remote"`).

## Implementation

*— deepseek (tentacle --profile deepseek), 2026-11-10*

### 1. A sanitized turn-error message for a trusted host (a)

`packages/daemon/src/hosted-session.ts` — beside `redactTurnError`, add

```ts
export const TURN_ERROR_MAX = 400;
export function sanitizeTurnError(error: unknown): TurnError
```

— the message of an `Error` (or `String(error)`), then: collapse every run of
whitespace/control chars to one space (`oneLine` semantics), mask the secret
shapes that can reach a provider message (a bearer token, `sk-…`, a URL's
credentials, `api_key=`/`token=`/`password=` assignments) with `[REDACTED]`, and
cap at `TURN_ERROR_MAX` characters with a trailing `…`. Pure, no I/O.
`redactTurnError(error, expose)`'s `expose` branch returns
`sanitizeTurnError(error)` instead of the raw message; the redacting branch is
untouched (`{ message: "internal error" }`).

Reuse, not a new vocabulary: `@tentacle/agent`'s `redactText`
(`packages/agent/src/redact.ts:44`) already holds exactly those rules. `daemon`
depends on `@tentacle/agent` (`packages/daemon/package.json:11`), so
`sanitizeTurnError` = `redactText(oneLine(message))` + the cap.

`packages/cli/src/serve.ts` — the `serve` `SessionHost` (the `reloadedHost`
literal) sets `exposeTurnErrors: true` next to the existing `onTurnError`. The pod
host (`podSessionHost`) does NOT. The `worker.ts` flag is unchanged (it becomes
sanitized too — same trusted class, an improvement, not a regression).

### 2. A second `send` never orphans a running turn (b)

`packages/client/src/remote-session.ts` `runTurn`: before installing the turn,
if `this.active && !this.active.ended` → restore the input and throw
`RpcError(DomainErrorCode.TurnInProgress, "a turn is already running")` — the
same code and wording the daemon uses, so every caller that already handles a
daemon refusal handles this. The in-flight turn keeps `this.active` and its
`turn_end`, so it ends. `sendNow`'s `this.next` path is unaffected.

### 3. The notice says whose model failed (c)

`packages/tui/src/model-error.ts` (new, pure): `modelErrorNotice(message, remote)`
→ `message` as is for a local agent; for `remote`, `message` + the hint
`— the daemon uses its own model config: run "tentacle config" on that host`.
Only for a model-shaped failure (the message mentions the model/endpoint/status
or the turn failed before any output) — anything else (a session lost, a link
that stopped) is left alone. `App.tsx:1999`'s `failTurn` call routes through it
with `model === "remote"`.

### 4. `serve` warns when no model is configured (d)

`packages/cli/src/serve-model-notice.ts` (new, pure):
`serveModelNotice(config)` → a line when the daemon has no API key
(`apiKeySource === "none"`) and is on the default endpoint+model, else `null`.
`main.ts`'s `serve` branch prints it beside `titleConfigNotice` (`:900`), through
the same `err(...)`/`[daemon]` sink. (In-process and pod daemons are untouched:
they either have the key or get the model through the tunnel.)

## Files to change

- `packages/daemon/src/hosted-session.ts` — `sanitizeTurnError`, `TURN_ERROR_MAX`; `redactTurnError`'s expose branch.
- `packages/cli/src/serve.ts` — `exposeTurnErrors: true` on the serve `SessionHost` only.
- `packages/client/src/remote-session.ts` — refuse a second concurrent `send` (`TurnInProgress`).
- `packages/tui/src/model-error.ts` (new), `packages/tui/src/App.tsx` — the remote hint.
- `packages/cli/src/serve-model-notice.ts` (new), `packages/cli/src/main.ts` — the start-up line.
- Tests: `packages/cli/test/connect-model-error.test.ts` (real stack),
  `packages/tui/test/connect-model-error.test.tsx` (the frame),
  `packages/daemon/test/hosted-session`-level unit tests for the sanitizer,
  `packages/client/test/remote-session`-level unit test for the refusal,
  `packages/cli/test/serve-model-notice.test.ts`.
- `CHANGELOG.md` `[Unreleased]` → Fixed.

## Failure modes

- A pod daemon must never expose a message: pinned by a `podSessionHost`-shaped
  test (no `exposeTurnErrors` on that literal) and by keeping the redacting
  branch untouched.
- A provider message carrying a key/URL: masked by `redactText`, capped — pinned
  by the sanitizer's unit tests (bearer, `sk-`, url creds, an over-long body).
- A refused second `send` must restore the caller's text exactly as a daemon
  refusal does: the existing `restoreInput` path is what runs (R3's TUI test
  asserts the text is back in the input, not lost).
- Empty/odd errors: `sanitizeTurnError("")` → `internal error` (never an empty
  message), as today.

## Tests

Red before green, on the real stack for (a), (b), (c); unit for (d) and the
sanitizer. Mutations named in each test's comment.

## Validation

`bun test` (narrow files while iterating), `bun run typecheck`, `bun run lint`,
then `bun run check`.

## Execution

*— deepseek (tentacle --profile deepseek), 2026-11-10*

### What was done, in order

1. **Reproduced both reports on the real stack before reading code.** A
   scripted OpenAI-compatible `Bun.serve`, a real `startDaemon` on a free port,
   the real `RemoteClient` with its real reconnect factory, and the real `App`
   in `ink-testing-library`. Five probe shapes were measured: a 401, an endpoint
   that refuses then returns, an engine that answers halfway and dies, an engine
   that accepts and says nothing, and a daemon stopped/restarted under a live
   client. Findings became R1–R5 in Context.
2. **`sanitizeTurnError`** in `hosted-session.ts` (one-line + `redactText` +
   400-char cap), wired into `redactTurnError`'s `expose` branch — the redacting
   branch is untouched.
3. **`exposeTurnErrors: true`** on the `serve` `SessionHost` only
   (`serve.ts`, `reloadedHost`); `podSessionHost` deliberately not.
4. **The orphan guard** in `remote-session.ts` `runTurn`: a second `send` while
   a turn is in flight throws `TurnInProgress` instead of clobbering
   `this.active`.
5. **`packages/tui/src/model-error.ts`** (pure) + one call site in `App.tsx`.
6. **`packages/cli/src/serve-model-notice.ts`** (pure) + one call in `main.ts`.
7. Tests, then mutations, then the gate.

### Drift from Implementation (and why)

- **§1's sanitizer is hand-written, not `oneLine` + cap.** `oneLine` lives in
  `@tentacle/tui`, which the daemon must not depend on; `noControlCharactersInRegex`
  rejects the equivalent regex, and an inline
  `// biome-ignore` in a security helper is a bad trade. `oneLineText` is the
  same rule as a small loop — it also drops the bidi/zero-width controls
  (`U+200B–200F`, `U+202A–202E`, `U+2060–2069`, `U+FEFF`) that `oneLine` drops,
  so a provider body cannot reorder the transcript. `redactText` (from
  `@tentacle/agent`, already a `daemon` dependency) supplies the secret rules —
  no new vocabulary.
- **§3's local path is byte-identical to before.** The brief said "the notice";
  `packages/tui/test/app.test.tsx:2615` pins a LOCAL failure as `⚠ Error: boom`.
  `modelErrorNotice` therefore returns `String(error)` verbatim when not remote,
  and applies the one-line/cap/hint form only to a failure that came over the
  wire (where the words are a daemon's, i.e. untrusted input). This is stricter
  than the plan and preserves an existing contract.
- **§2's guard is on `send`, not on the reconnect path.** `sendNow` keeps its
  own `this.next` hand-off (unchanged); only `runTurn` refuses, so a TUI
  `send-now` still supersedes a running turn exactly as before.
- **A sixth test was added** (`Esc escapes a hung model call`): R3's hang is not
  fixable by a client-side timeout without inventing a policy (see Review), but
  the TUI's escape route is, and it is now pinned.

### Gate

```
npx tsc --noEmit                    → clean
bun run lint                        → "Checked 855 files … No fixes applied."
bun test (all but apps/mobile)      → 6651 pass, 3 skip, 0 fail, 465 files, 235 s
```

`apps/mobile` is excluded from the test run and from `tsc -p apps/mobile` in
this worktree: its dependencies are not installed here (`Cannot find module
'react-native'`, `expo`), so both fail for reasons unrelated to this branch
(CI installs with `--filter '!@tentacle/mobile'`; the root `tsc --noEmit`, which
is the gate for every package this task touches, is clean).

One unrelated flake was seen once in the full run and did not reproduce in 5
isolated runs afterwards:
`packages/daemon/test/session-log-store.test.ts` "T4 the fork precedes the
source's next write" (a 60 ms sleep against a gated fork). Neither that test nor
`session-log-store.ts` is touched by this branch.

### Red-before-green, and the mutations that bite

| Test | Mutation | Result |
|---|---|---|
| `(a) a 401 is a failed turn with the provider's message` | `exposeTurnErrors: false` in `serve.ts` | fails (`internal error`) |
| `(a) the exposed message is sanitized` | same | fails |
| the TUI frame test (`status 401 … tentacle config`) | same | fails |
| the TUI frame test | `failTurn(…, String(error))` (no hint) | fails on `tentacle config` |
| `(b) a second send while a turn runs …` | `if (false)` for the orphan guard | **fails with `HUNG`** — the first turn never settles, exactly the owner's report |

Before the fixes the frame was `⏺ ⚠ RpcError: internal error`, and after two
probe sends the first turn was still pending with the daemon reporting
`running: false` — the wedge, on the wire.

## Review

*— deepseek (tentacle --profile deepseek), 2026-11-10 — self-review only; a
fresh-context Opus pass is still owed (Blast: load-bearing, AGENTS §10).*

### Verdict per item

| Item | Verdict | What is and is not covered |
|---|---|---|
| **(a)** a model error is a failed turn with the provider's message, link kept, next send works | **FIXED** | Real-stack test: 401 → `model request failed with status 401: Invalid API Key`; the next send on the same session returns `recovered`. The message is one line, secret-masked, capped at 400. The pod path is untouched (`podSessionHost` sets no flag) — its behaviour is pinned by the still-green `integration.test.ts` redaction cases. |
| **(b)** a dropped connection reconnects to the same session, never a state where every send fails | **PARTIAL** | The reconnect half already held and is now pinned by a test (daemon restart → same session id → the send runs). The "every send fails" half — the orphaned turn — is **FIXED** and mutation-proven. **Not fixed:** a model call that hangs with the socket up has no bound (root cause 3). A turn there stays `Working…` until the user presses Esc (pinned by its own test) or the OS's own TCP/stream timeout fires. Bounding it needs a product decision (a first-byte/idle timeout for a model call, and what to tell the user), which is out of this fix's blast radius — proposed as a follow-up below. |
| **(c)** the notice names the daemon's own model config | **FIXED** | The remote notice reads `… — the daemon runs its own model: check its config and key with "tentacle config" on that host`, asserted in a real TUI frame. A local failure renders exactly as before. |
| **(d)** `serve` warns at start-up with no model | **FIXED** | `serveModelNotice` + one `[daemon]` line in `main.ts`; unit-tested for the four cases (no key, file key, command key, an explicitly configured endpoint/model). Not covered end to end (it is a `main.ts` print), which is honest but thin. |

### What holds, and what does not

- **Holds:** the redaction policy is now split by TRUST, not by runtime kind —
  the serve host (the user's machine, the only persisting daemon) exposes a
  sanitized message; a pod does not. Both are pinned.
- **Holds:** the orphan guard cannot break `send_now` (`this.next` is separate),
  nor a genuinely sequential send (the guard only fires while a turn is
  un-ended).
- **Does not hold:** a hung model call. This is the one place the owner's "only
  Ctrl+C worked" can still be reproduced, and the doc says so rather than
  claiming (b) whole.
- **Risk taken:** `exposeTurnErrors: true` widens what a `serve` client can see
  from `internal error` to a sanitized upstream string. `redactText` is a
  pattern list, not a guarantee (its own header says so: "defence-in-depth");
  the 400-char cap bounds the exposure. The residual risk is a secret shape no
  rule matches — accepted, because the alternative is the status quo (a user
  cannot tell a bad key from a broken daemon), and the host is the user's own.

### Follow-ups (deliberately not done here)

1. **A first-byte / idle bound for a model call** (`providers`), failing the turn
   as `ModelUnreachableError`-shaped. It changes `providers`' contract and needs
   an owner decision on the default window; it would close (b) completely.
2. **A fresh-context Review** (load-bearing): re-run the gate, and red-team the
   sanitizer against a real provider body.
3. `TODO.md`'s entry is intentionally untouched (the brief forbids it).

### How the implementing model behaved

Two-strike rule applied twice, productively: static reading alone could not
explain "every later send fails", so the switch was to empirical frame logging
(`probe-frames`), which found the orphan in one run after several code-reading
passes had not. One loop was caught and broken: `rg -rn` was silently
`-r n` (replace-with-`n`), which corrupted several searches — re-running as
`rg -n` fixed it. The measurements that mattered (the frame traces, the 401
text) were all executed, never reasoned.


