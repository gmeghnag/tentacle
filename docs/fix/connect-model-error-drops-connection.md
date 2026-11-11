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



## Implementation — round 2

*— deepseek (tentacle --profile deepseek), 2026-11-11*

Round 1 fixed whose *error text* a client sees. Round 2 fixes whose *model facts*
the `connect` TUI shows, and answers the carried-`contextWindow` question
(`TODO.md`: `fix/connect-ctx-window` folded in, plus item D of
`fix/connect-functest-batch`).

### Load-bearing assumption

**The `serve` daemon and its clients disagree about which model is running, and
the daemon is the only side that knows.** Proven by probe (real `startDaemon`,
real `RemoteClient`, real `App`, daemon window 200000, laptop env
`TENTACLE_CONTEXT_WINDOW=71680`):

```
initialize: {"protocolVersion":22,"agentCapabilities":{…},"agentInfo":{"version":"dev"}}
─── remote ─                 ← the input rule (item D)
ws://127.0.0.1:57144 · ctx ░░░░░░░░░░ ~2% (~2.7k/128k)     ← the meter (item 1)
```

`128k` is `App`'s own default (`packages/tui/src/App.tsx:591`) — `connect.ts`
passes no `contextWindow` at all (`packages/cli/src/connect.ts:217` passes only
`model: "remote"`), and `remote` is a *magic* string, not a name. The daemon's
window never crosses the wire: `InitializeResultSchema` carries only
`protocolVersion`, `agentCapabilities` and `agentInfo{version}`
(`packages/protocol/src/session.ts:183-188`), and `SessionHost` has no model fact
to report (`packages/daemon/src/session-host.ts:198` is `identity` only).

### Preconditions (verified here)

- **`agentInfo` is the right existing field to extend.** It is the daemon's own
  facts, sent once per connection at `initialize` — before Ink mounts and before
  any session exists (a `connect` session is created lazily at the first prompt,
  `packages/cli/src/connect.ts:219-224`), which is exactly when the meter needs
  it. `OpenResult` is per-session and too late (`session.ts:808`).
- **`agentInfo` is built from the host in one place**
  (`packages/daemon/src/connection.ts:452`), and `serve` is the only daemon that
  sets `identity` from a host whose model is its own (`packages/cli/src/serve.ts:207`);
  the pod (`serve.ts:517`) and the worker (`packages/cli/src/worker.ts:109`)
  also set it, so the model facts are a separate option, not part of
  `DaemonIdentity`.
- **A carried `contextWindow` is honoured by ONE code path, the pod's.**
  `applyCarried` has exactly two call sites, both in `serve.ts` and both in the
  `--model-proxy` (pod) agent factory (`packages/cli/src/serve.ts:428`, `:521`);
  the `serve` host builds each session's agent from its OWN config
  (`serve.ts:183-196`) and never sees `session/open.settings`. A settings sync on
  `serve` returns `{applied: false}` because its factory reports no
  `settingsReport` (`packages/daemon/src/session-host.ts:1014-1026`).
- **`connect` already sends no `settings` at all**, pinned by
  `packages/cli/test/connect.test.ts:188` ("connect never sends `settings`"), so
  item 2's answer is structural, not accidental.
- The daemon's effective window is its `config.contextWindow`: it is what the
  context line the model sees is computed against
  (`packages/cli/src/wiring.ts:496-500` → `packages/agent/src/agent.ts:1422`).
- `model` in the TUI is not just a label: `App.tsx:2015` tests
  `model === "remote"` to decide the daemon's-own-model hint (round 1's fix). The
  daemon's name therefore needs its OWN prop — overloading `model` would silently
  undo round 1.

### Design

1. **The daemon reports its model facts, as a NAME and a number.** Extend
   `agentInfo` (additive, display-only):

   ```ts
   agentInfo: z.object({
     version: z.string(),
     /** This daemon's own model, for display — a bounded line, never an id, a URL or a key. */
     model: line(128).optional(),
     /** The window that model counts against (what its context line uses). */
     contextWindow: z.number().int().positive().max(999_999_999).optional(),
   }).optional()
   ```

   `line()` (`packages/protocol/src/text-line.ts`) is the existing "display text
   from a maybe-hostile peer" type: non-empty, bounded, no control characters.
   Not `ModelNameSchema`: a real model string (`rits/deepseek-ai/DeepSeek-…`) is
   not `[A-Za-z0-9_-]`.

   `SessionHostOptions.modelInfo?: { name: string; contextWindow: number }`
   (`session-host.ts`, beside `identity`) → `Connection.initialize` spreads it
   into `agentInfo` (`connection.ts:452`). `serve`'s `reloadedHost` passes
   `{ name: config.model, contextWindow: config.contextWindow }` — its own
   config, never the client's. Pod and worker pass nothing: a pod's model is the
   LAPTOP's (AGENTS §7, reverse tunnel) and `connect` never meets one, so the
   field stays absent there and the TUI keeps today's default.

   **No `PROTOCOL_VERSION` bump**: an added OPTIONAL field inside `agentInfo`,
   which is a strip schema — an older client drops it and shows today's
   `128k`/`remote`. Nothing mandatory, nothing blocking, no changed meaning.

2. **`connect` hands the daemon's facts to the TUI.** `connectTui` keeps the
   `initialize` result (today discarded at `connect.ts:203`) and passes
   `contextWindow` + a NEW `modelLabel` to `startTui`. The label is sanitised at
   the client (`oneLine` + cap, the `untrustedText` rule) before it can reach the
   ink tree — a daemon is not to be trusted with terminal control.

3. **The TUI uses the label for display and keeps `model` for semantics.**
   `TuiOptions.modelLabel?: string` (`run.tsx`) → `AppProps.modelLabel?`
   (`App.tsx`); `App` derives `shownModel = modelLabel ?? model` and uses it for
   the input rule (`App.tsx:4013-4014`) and `/model` (`App.tsx:2980`) only.
   `modelErrorNotice(error, model === "remote")` is untouched.

4. **Item 2 needs no fix — it needs a pin.** `connect` sends no settings
   (already pinned) and a `serve` daemon builds every agent from its own config,
   so its context line, its warns and its `/compact` threshold are its own
   window. Carrying it is CORRECT where it does apply (a pod `--model-proxy`
   daemon: there the laptop's model IS the model). The regression test drives the
   real stack with a client that DOES carry a laptop `contextWindow` (the pod
   shape) and asserts the `serve` daemon's request still says its own window.

### Files

- `packages/protocol/src/session.ts` — `agentInfo.model`, `agentInfo.contextWindow`.
- `packages/protocol/schema/protocol.json` — regenerated (`bun run schema:export`).
- `packages/daemon/src/session-host.ts` — `SessionHostOptions.modelInfo` + field.
- `packages/daemon/src/connection.ts` — `initialize` spreads `modelInfo`.
- `packages/cli/src/serve.ts` — `modelInfo` on the `serve` host only.
- `packages/cli/src/connect.ts` — keep the handshake result, pass `contextWindow` + `modelLabel`.
- `packages/tui/src/run.tsx`, `packages/tui/src/App.tsx` — `modelLabel`, `shownModel`.
- Tests: `packages/cli/test/connect-model-error.test.ts` (real serve+connect:
  facts on the wire, the carried-window pin), `packages/tui/test/connect-model-error.test.tsx`
  (the frame: `200k` and the name), `packages/daemon/test/integration.test.ts`
  (`agentInfo`'s new fields; absent without `modelInfo`).
- `CHANGELOG.md` `[Unreleased] → Fixed`.

### Failure modes

- **A daemon that reports nothing** (older, pod, worker): the field is absent →
  `connect` passes nothing → the TUI shows exactly what it shows today (`128k`,
  `remote`). No half-state.
- **A hostile label** (`\x1b[…`, 4 KB): `line(128)` rejects it at the peer's parse
  (`modelInfo` is the daemon's, but the client validates), and `connect`
  sanitises again with `oneLine` + a cap before it reaches Ink (§7: one gate each
  side).
- **A window of 0 / negative / absurd**: refused by the schema; the client falls
  back to its default rather than dividing by zero (the meter's own guard,
  `status-line.ts:158-175`).
- **A reconnect after the mount**: `initialize` runs again on the redial, but the
  TUI keeps the facts it mounted with. Acceptable and documented: a `serve`
  daemon's own model config does not change under a live process (`tentacle
  config` writes take effect at its next start).
- **Item 2's real risk** — carrying `contextWindow` to a daemon that uses its own
  model — is a regression PIN, not a fix: the pod path must keep honouring it.

### Tests

Red before green on the real `serve` + `connect` stack for items 1 and 3, and a
TUI frame for both. Item 2's test is green-before/after by construction (nothing
changes); its non-vacuity is shown by mutation (`applyCarried` wired into the
serve factory → the assertion fails).

## Execution — round 2

*— deepseek (tentacle --profile deepseek), 2026-11-11*

### What was done, in order

0. **`git merge main` first** (main was at 22): one conflict, `CHANGELOG.md`
   `[Unreleased] → Fixed` (this branch's round-1 entries vs. main's new ones) —
   kept both blocks, both in the same section. Merge commit `60d2fce`; the tree
   gated after it (see Gate).
1. **Probed the real stack before touching code** (`.tentacle/tmp/connect-model-error/probe1.test.tsx`):
   real `startDaemon` with `contextWindow: 200000`, real `RemoteClient`, real
   `App`, laptop env at 71680. The frame showed `ctx …/128k` and `─── remote ─`,
   and `initialize` carried `agentInfo{version}` only. Both round-2 symptoms and
   the absence of any model fact on the wire, measured — not inferred.
2. **Protocol**: `agentInfo.model` (`line(128)`) and `agentInfo.contextWindow`
   (optional, positive, ≤ 999999999) — `packages/protocol/src/session.ts`.
   `bun run schema:export`: `protocol.json` +11 lines, `x-protocol-version` still
   22.
3. **Daemon**: `SessionHostOptions.modelInfo` + the host's field
   (`session-host.ts`), spread into `agentInfo` by `Connection.initialize`
   (`connection.ts`). **`serve` only** passes it (`serve.ts`, its own
   `config.model` + `config.contextWindow`); the pod and the worker pass nothing.
4. **Client**: `servedModel(handshake)` (new, pure, exported) in `connect.ts` —
   one line + a 64-cell cap (`oneLine`, the `untrustedText` rule), and a window
   dropped when it is not a positive integer or when there is no name to
   attribute it to. `connectTui` keeps the handshake result (it used to discard
   it) and passes `modelLabel` + `contextWindow` to `startTui`.
5. **TUI**: `TuiOptions.modelLabel` → `AppProps.modelLabel`; `App` derives
   `shownModel = modelLabel ?? model` and uses it at exactly two display sites —
   the input rule (`inputRuleText`) and `/model`'s notice. `model === "remote"`
   (the error hint, round 1's (c)) is untouched.
6. **Tests** (red before green, mutations below), then the doc and `CHANGELOG.md`.

### Drift from Implementation (and why)

- **`agentInfo` needs `identity`.** The plan spread `modelInfo` beside the
  `agentInfo` object; the code nests it INSIDE, so facts without an `identity`
  produce no `agentInfo` at all. Every real host sets both, and it keeps the
  wire shape honest (`agentInfo` is "who answers"). First written wrong and
  fixed while typechecking.
- **`servedModel` is exported** and unit-tested (the plan had it private,
  covered only through the stack). The edge cases the plan listed as failure
  modes — a hostile label, a window with no name, a nonsense window — are cheap
  as pure cases and would be flaky to force through a daemon.
- **Item 3's fix is presentation-only, as planned, but `modelLabel` also feeds
  `/model`.** Not in the plan; it is the same "what is painted" question, and a
  `/model` that answered `remote` while the rule named the daemon's model would
  be the same bug one screen over.

### Gate

```
npx tsc --noEmit                 → clean (0 errors)
bunx biome check .               → "Checked 864 files … No fixes applied."
bun test (all but apps/mobile)   → 6761 pass, 3 skip, 474 files, 256 s
```

`apps/mobile` is excluded as in round 1: its dependencies are not installed in
this worktree (`Cannot find module '@tentacle/client'`; `tsc -p apps/mobile`'s
47 errors are all `apps/mobile`/`node_modules` — 0 in any package this task
touches). CI installs with `--filter '!@tentacle/mobile'` (AGENTS §6).

### Red-before-green, and the mutations that bite

| Test | Mutation | Result |
|---|---|---|
| `(1) the daemon reports its own model NAME and window` (real serve+connect) | drop `modelInfo` from `serve.ts` | **fails** (`agentInfo.model` undefined) |
| `the ctx meter and the input rule show the serve's own model` (TUI frame) | `servedModel` returns `{}` (what `connect` did before) | **fails**, and the frame is the owner's report: `─── remote ─`, `ctx …/128k` |
| the same frame test | `shownModel = model` in `App.tsx` | **fails** (`served-m` missing) |
| `(2) a carried contextWindow never moves a serve daemon's own window` | wire `applyCarried(config, ctx?.settings)` into `serve.ts`'s `createAgent` | **fails**: the request says `[context: 2k / 72k tokens (3%)]` — the carried 71680, the owner's suspicion, reproduced and excluded |
| `L1b initialize: agentInfo carries the daemon's own model facts` | — (unit pin) | passes; absent-`modelInfo` shape asserted as today's |
| `servedModel` (5 pure cases) | pass `info.model` raw | the hostile-label case fails |

Every red was observed before the fix, and each mutation was reverted and the
suite re-run green.
