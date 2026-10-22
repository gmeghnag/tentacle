# fix/in-process-hooks-trust-schema — the in-process trust ask skips the wire schema

> **Status:** execution
> **Branch:** `fix/in-process-hooks-trust-schema`
> **Type:** fix · **Size:** S · **Blast:** load-bearing (§7 trust) · **Suited:** strong model + mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-22*

Project hooks (`.agents/hooks.json`, docs/feat/hooks-project-trust.md) that
`hooks/trust` cannot carry (over the limits, control or bidi characters) must
**never run**. On every RPC path this holds: the request fails
`HooksTrustParamsSchema` (outbound in the daemon's peer, inbound in the
laptop's), the ask rejects, and the runner declines. In the `--in-process` TUI
and the worker-failure fallback there is no RPC: `inProcessAgents`'
`askHooksTrust` (`cli/src/wiring.ts:308-324` before the fix) handed the request
straight to the resolver. An over-limit hook was offered, trusted and loaded;
`main.ts:292` only warns at startup. The in-process runner also had no log
sink, so nothing recorded why hooks did not run.

Found by the docs/extensions.md accuracy review.

**Repro (2026-10-22, before the fix)** — `.tentacle/tmp/in-process-hooks-trust-schema/repro.ts`:

```ts
const projectHooks = { folder: "/repo", hash: "h1", files: [".agents/hooks.json"],
  hooks: [{ event: "turn_start" as const, command: `echo ${"x".repeat(5000)}` }] };
const { permissions, build } = inProcessAgents({ ...config, projectHooks });
permissions.setRequester(async () => ({ allowed: true, scope: "once" }));
const cfg = (build().agent as unknown as { config: { hooks: HookRunner; askHooksTrust: AskHooksTrust } }).config;
await cfg.hooks.resolveProjectTrust("s1", cfg.askHooksTrust);
console.log('… hasAny("turn_start") =', cfg.hooks.hasAny("turn_start"));
```

```
over-limit command (5005 chars) loaded: hasAny("turn_start") = true
```

## Implementation

*— claude-opus-5-5, 2026-10-22*

### Load-bearing assumption

A throwing asker declines the project hooks for the session and logs why:
`HookRunner.resolveProjectTrust` catches a rejected ask, sets `"declined"`
and logs `the ask failed: …` through `opts.log`
(`agent/src/hooks.ts`, the `catch` in `resolveProjectTrust`). This is the
same path an RPC schema failure takes.

### Preconditions

- `HooksTrustParamsSchema` (`protocol/src/hooks.ts`) is the single source of
  truth for what a trust request may carry. `@tentacle/cli` already depends on
  `@tentacle/protocol`.
- The in-process agents share one broker (AGENTS §7): unchanged.

### Design

In `inProcessAgents`' `askHooksTrust`: `HooksTrustParamsSchema.safeParse` the
request, exactly as the wire would. On failure, throw
`invalid hooks/trust request (<path>: <message>)`. The runner then declines
and logs it, and the broker is never asked. On success, resolve with
`parsed.data`. No second validator.

`inProcessAgents` also passes `log` → `logDaemonError(config.configDir, …)`
to `buildAgent`, the worker's sink (`worker.ts`), so the reason is recorded
and never written to the terminal Ink owns.

### Files

- `packages/cli/src/wiring.ts` (`inProcessAgents`)
- `packages/cli/test/wiring.test.ts` (regression test)

### Failure modes

| Case | Convergence |
|---|---|
| Over-limit / control / bidi hook | the ask throws → declined for the session, logged; the broker is never asked |
| Valid hooks | unchanged: parsed data goes to the resolver |
| Log write fails | `logDaemonError` is best-effort (it swallows); the decline still holds |

### Tests

`wiring.test.ts` "in-process: hooks the wire schema rejects are declined, never
asked, and logged". It uses a 5,000-char command and checks four things:
`hasAny("turn_start") === false`, the session is decided, the broker was never
asked, and the daemon error log names `hooks.0.command`. It is red on the
current code. The mutation that passes the unchecked request through must fail
it.

## Execution

*— claude-opus-5-5, 2026-10-22*

1. Repro (above) on the branch before any edit: `hasAny("turn_start") = true`.
2. Wrote the regression test first: **red** on `expect(hooks.hasAny("turn_start")).toBe(false)` (Received: true).
3. Fix in `packages/cli/src/wiring.ts` `inProcessAgents`:
   - `HooksTrustParamsSchema.safeParse`, throwing on failure;
   - `resolve(parsed.data, …)`;
   - `log` → `logDaemonError`.

   Test green; repro now prints `false`.
4. Mutations, each red then reverted:
   - the unchecked request passed through → red on `hasAny` (Received: true);
   - `log` not passed → red on the log assertion.
5. Drift: none in design. Side effect: the in-process runner now logs ignored
   hook failures to the daemon error log too (before, it had no sink and they
   were dropped), the same as the worker.
6. Gate: `bun run check` green — typecheck clean, lint 0/0, 1822 pass / 2 skip (opt-in) / 0 fail.

## Review

*— claude-opus-5-5, 2026-10-22 — fresh-context adversarial review. **Same model as the executor** (only the context is fresh), so shared blind spots are possible.*

### Verdict: **APPROVE-WITH-NITS**

**Gate:** `bun run check` on the clean tree. Typecheck clean · lint
`Checked 373 files … No fixes applied` (0/0) · **1822 pass / 2 skip (opt-in) / 0 fail**.
This matches the Execution.

**Repro:** `.tentacle/tmp/in-process-hooks-trust-schema/repro.ts` now prints
`hasAny("turn_start") = false`. On the pre-fix code it was `true`, as the
Execution states, and mutation M1 below reproduces that.

**Mutations** (each one reverted; the tree hash `b40e318c…` was unchanged
afterwards). Each mutation made the new test fail (14 pass / 1 fail):

| Mutation | Result |
|---|---|
| M1: the unchecked request goes through (the pre-fix behaviour) | red ✓ |
| M2: `log` not passed to `buildAgent` | red ✓ |
| M3: the asker returns `false` instead of throwing | red ✓ (on the log assertion) |

**Can the throw crash or hang a turn? No.** The asker is an `async`
function, so its `throw` becomes a rejection. `resolveProjectTrust` catches
that rejection inside its `Promise.race`, records "declined", logs the
reason, and never throws. I checked this end to end with
`review/turn.ts`: a real `Session.send` through `inProcessAgents`, with a
5,005-char command.

```
turn ended: {"type":"turn_end","reason":"end_turn"} ms: 3 asked: 0 hook ran: false
log: [...] project hooks of <home> not run this session (the ask failed: invalid hooks/trust request (hooks.0.command: String must contain at most 4096 character(s)))
```

**Other paths into the resolver:** I listed every caller with grep
(`askHooksTrust`, `createHooksTrustResolver(`, `inProcessAgents(`).

| Path | How the schema is enforced |
|---|---|
| Worker and pods (`local-runtime.ts:212`) | Through `RemoteClient`. The peer checks params inbound (`peer.ts:325`); the daemon's peer also checks outbound |
| `connect` (`connect.ts:117`) | Through `RemoteClient`, same inbound check |
| Daemon (`hosted-session.ts`) | Asks only through `Connection` (`peer.request`, checked outbound) |
| `--plain` / one-shot | No asker, so hooks are declined |
| `inProcessAgents` (`main.ts:612`: `--in-process` and the worker-failure fallback) | Was the only unchecked path. It is now fixed |

**§7, no raw terminal write:** holds. `logDaemonError` only appends to
`<configDir>/logs/daemon-errors.log`, and swallows its own failures. The
e2e run printed nothing to the terminal.

**Nits:**

1. `logDaemonError(configDir, line)` wraps each string in `new Error`. Every
   hook line, including routine ignored-hook failures that now land here
   too, therefore carries a useless logger stack trace. *Suggest:* a
   plain-line append (as `logModelRetry` does).
2. The regression test covers only the length limit, not control or bidi
   characters. Those are the same schema call, so the risk is low. One
   extra case would pin the "control/bidi" claim in the failure-mode table.

**Executor behaviour:** the doc is accurate. Its gate numbers, red/green
claims and mutations all reproduced. The scope stayed small.
