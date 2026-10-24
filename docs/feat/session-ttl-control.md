# feat/session-ttl-control — `--session-ttl never` and changing the TTL on a running daemon

> **Status:** implementation (split doc APPROVED by the owner 2026-10-23 16:3x; plan approved by the owner 2026-10-23, task 2 Q3/Q4: split, this half FIRST; a runtime change is NOT persisted — the flag wins at restart, and the method says so)
> **Branch:** `feat/session-ttl-control`
> **Size:** S · **Blast:** cross-module · **Suited:** strong model executes (one new wire method = protocol shared truth); standard Review, fresh-context preferred

Type: feat · Size: S · Blast: cross-module · Suited: strong model + standard Review (fresh-context preferred)

## Context

*— claude-opus-5-5, 2026-10-23*

Task 2b of `docs/eval/mobile-app.md` decision 21 row 2, split from task 2
(`docs/feat/session-archive.md`, 2a, which executes AFTER this one). Decision 4:
"TTL configurable, including infinite: extend the existing
`serve --session-ttl 24h` (durations already parsed) with `never`, plus a way to
change it on a running daemon — exact shape decided in Implementation".

Owner answers (2026-10-23): split, 2b first; a runtime change is **not
persisted** (the `--session-ttl` flag is the truth at every start) and the
method's contract says so.

This half is independent of 2a: today the reaper CLOSES (and deletes) at the
TTL; after 2a it archives. Either way this task only decides **when** the reaper
acts, never **what** it does.

Today (verified on `main`):

- `--session-ttl` goes through `parseDuration`, which accepts only
  `<1-9 digits>(ms|s|m|h)` > 0 and throws otherwise
  (`packages/cli/src/flags.ts:208-216`, used at `:268`); `ServeLimits.sessionTtlMs?: number`
  (`:219-225`). `never` → `--session-ttl: invalid duration "never" …`.
- The policy is fixed at start: `listen` computes `idleTtlMs` once and calls
  `startReaper` once (`packages/cli/src/serve.ts:187-199`); the returned stop
  function is the only handle (`:188`, `:206`).
- `ReapPolicy.idleTtlMs: number` (`packages/daemon/src/session-reaper.ts:20-25`);
  `expiry` compares `now - lastActiveAt >= idleTtlMs` (`:69-80`).
- The sweep period is `sweepIntervalFor(ttl, cap)` = clamp(1 s, min(60 s, ttl,
  cap)) (`serve.ts:29-42`), unless the `sweepIntervalMs` test override is set
  (`:53-54`, `:195`).
- No method reads or changes it: `Method` has no such entry
  (`packages/protocol/src/methods.ts:42-58`); `Connection.onRequest`'s dispatch
  (`packages/daemon/src/connection.ts:159-183`).
- Pod daemons (`serve --stdio`) and the in-process worker run **no reaper**
  (`startStdioDaemon`, `serve.ts:224-302`, has no `startReaper`; the only call
  site is `serve.ts:188`).

**Repro** (to run by the executor on `main` before any edit — the planner's
sandbox could not execute in `.tentacle/tmp/` this round; the facts above are
read from the cited lines). From `.tentacle/tmp/session-ttl-control/`:

```ts
// 2b on main: `--session-ttl never` is rejected, and no method reads/changes the TTL.
import { parseArgs, parseServeLimits } from "../../../packages/cli/src/flags.ts";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";

const parsed = parseArgs(["serve", "--session-ttl", "never"]);
if (!parsed.ok) throw new Error(parsed.error);
try {
  console.log("limits:", parseServeLimits(parsed));
} catch (error) {
  console.log("--session-ttl never ->", (error as Error).message);
}
console.log("protocol", PROTOCOL_VERSION, "methods:", Object.values(Method).join(" "));
```

Expected (from `flags.ts:212-215`, `:256-260`): `--session-ttl never ->
--session-ttl: invalid duration "never" (use e.g. 24h, 90m, 45s, 1500ms)`, and
no `daemon/session_ttl` in the method list.

## Implementation

*— claude-opus-5-5, 2026-10-23*

### Load-bearing assumption

**The reaper's policy has exactly one owner on a daemon — `listen` in
`serve.ts` — so re-arming it there (stop the old interval, start a new one) is a
complete, race-free runtime change; nothing else caches the TTL.** Proof:

- `startReaper` is called once, in `listen` (`serve.ts:188`; the only non-test
  call site — `rg startReaper packages/*/src`); its `policy` is captured by the
  interval closure (`session-reaper.ts:114-122`) and nowhere else.
- `ws-server.ts` takes no TTL (`rg -i ttl packages/daemon/src/ws-server.ts` — no
  match); `SessionHost` has no TTL field (`session-host.ts:48-85`): the host
  only answers `reapExpired(policy)` with the policy it is GIVEN
  (`session-host.ts:257-263`).
- A sweep is synchronous (`reapExpired`, `session-host.ts:249-274`) and runs
  inside the interval callback; JS is single-threaded, so a `clearInterval` +
  new `setInterval` from a request handler can never interleave with a sweep in
  progress.

### Preconditions

- **Methods are additive, no bump** (AGENTS §7 "Fields and methods are free";
  `PROTOCOL_VERSION = 10`, `packages/protocol/src/version.ts:7`). An older
  daemon answers `MethodNotFound` from the peer before any handler (proved for
  `session/list` in `docs/feat/session-list.md` Repro).
- **The client validates the result; the daemon sends it as is**
  (`docs/feat/session-list.md` Preconditions, `transport/src/peer.ts`); the
  result here is a single nullable int, built from the value in force.
- **Handlers run concurrently, never under a lock** (AGENTS §7). The set is
  synchronous (no `await`), so two concurrent sets are ordered and the last wins.
- **`Connection.onRequest`'s `default` throws `NotInitialized` "unexpected
  method"** (`connection.ts:182-183`) — so a host without TTL control must throw
  `MethodNotFound` explicitly in the new case (`JsonRpcErrorCode.MethodNotFound`,
  `packages/protocol/src/jsonrpc.ts:19`), not fall through.
- **Authorisation**: one token = one principal (comment at
  `packages/protocol/src/session.ts:266`); per-device auth is task 9. Same as
  `session/close`, which any client may already call.
- **Pattern to copy**: `skills/list` — protocol `skills.ts` + `methods.ts`
  entry (`methods.ts:95`), host field, dispatch (`connection.ts:177-178`),
  `RemoteClient.skillsList` guards (`packages/client/src/remote-client.ts:308-319`),
  JSON Schema fixture per method (`packages/protocol/test/json-schema.test.ts:61`,
  `:308`).

### Design

#### CLI (`packages/cli/src/flags.ts`)

- `--session-ttl never` → `sessionTtlMs: null`; any other value →
  `parseDuration` as today. `ServeLimits.sessionTtlMs?: number | null`. The
  filter at `:274-276` drops only `undefined`, so `null` survives.
- Help text (`packages/cli/src/main.ts:114`): `[--session-ttl 24h|never]`.

#### Policy (`packages/daemon/src/session-reaper.ts`)

- `ReapPolicy.idleTtlMs: number | null` — `null` = never idle-expires.
  `expiry` (`:69-80`): the idle branch only when `idleTtlMs !== null`; the
  admin cap is unchanged (still applies under `never`).
- `sweepIntervalFor(idleTtlMs: number | null, adminCapMs?: number): number | null`
  MOVES here from `serve.ts:29-42` (it is reaper policy) — `null` when there is
  neither a TTL nor a cap (nothing to sweep for). Re-exported from
  `@tentacle/daemon`; `cli/test/serve-limits.test.ts:9` imports it from the
  new place.
- `startReaper` unchanged.

#### Runtime change — `daemon/session_ttl`

- **Wire** (new `packages/protocol/src/daemon.ts`, exported from `index.ts`;
  daemon-wide, not a session method):

  ```ts
  // --- daemon/session_ttl ----------------------------------------------
  // Read, or change, this daemon's idle TTL: how long a session nobody is
  // attached to and that runs nothing is kept loaded. `idleTtlMs` absent →
  // read only; a positive integer → the new TTL; null → never. The result is
  // the value now in force. A change lasts until the daemon restarts: it is
  // NOT persisted, the `--session-ttl` flag is the TTL at every start. Applied
  // at once (a session already past a lowered TTL goes at the next sweep).
  // A daemon without an idle reaper (a pod, the in-process worker) answers
  // MethodNotFound. Any authenticated client may call it (one token = one principal).
  export const SessionTtlParamsSchema = z.object({
    idleTtlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  });
  export const SessionTtlResultSchema = z.object({
    idleTtlMs: z.number().int().positive().nullable(),
    /** Always false: a change lasts until restart (the flag wins). Lets a UI say so. */
    persisted: z.literal(false),
  });
  ```

  `persisted: false` is the "the command says so" of the owner's answer: the
  contract states it, and a UI (task 7 / 11) renders "until the daemon
  restarts" from the result instead of hard-coding it. *(Corrected in
  follow-up 1:)* widening it to `z.boolean()` later is NOT additive — an older
  client validates the result and rejects `persisted: true` — so a persisted
  runtime TTL needs a `PROTOCOL_VERSION` bump (2a bumps 10→11 anyway: fold it
  in there if it is wanted by then).
  *(Also changed in follow-up 1: the wire spells "never" as the literal
  `"never"`, not `null`; see Execution — follow-up 1, item 4.)*
- `Method.SessionTtl = "daemon/session_ttl"`, `RequestSchemas` entry
  (`methods.ts:42-58`, `:76-97`).
- **Host seam** (`packages/daemon/src/session-host.ts`): option
  `sessionTtl?: SessionTtlControl` where
  `interface SessionTtlControl { get(): number | null; set(idleTtlMs: number | null): void }`;
  `SessionHost.sessionTtl(params): SessionTtlResult` — absent control →
  `RpcError(JsonRpcErrorCode.MethodNotFound, "session TTL is not configurable on this daemon")`;
  else `set` when `idleTtlMs !== undefined`, then `{ idleTtlMs: get(), persisted: false }`.
  Synchronous.
- **Dispatch** (`connection.ts:159-183`): `case Method.SessionTtl: return this.host.sessionTtl(params as SessionTtlParams);`
  after the `initialized` gate.
- **Owner of the policy** (`packages/cli/src/serve.ts`): `listen` keeps
  `let policy` and `let stopReaper`; `arm()` = `stopReaper?.()`, then
  `startReaper(...)` iff `sweepIntervalFor(policy)` (or the `sweepIntervalMs`
  override) is non-null. The control handed to the host: `get` → `policy.idleTtlMs`;
  `set(ms)` → `policy = { ...policy, idleTtlMs: ms }`, `arm()`, audit
  `session-ttl <old> -> <new>` (`never` for null). The host is built before
  `listen` (`serve.ts:96-97`), so the control is a small object created in
  `startDaemon`, passed to `reloadedHost` (into `SessionHostOptions`) and
  bound by `listen` (its `set` before binding = a programming error, throw).
  `ServeHandle.stop` stops whichever reaper is current.
- **Client** (`packages/client/src/remote-client.ts`):
  `sessionTtl(idleTtlMs?: number | null): Promise<SessionTtlResult>`, guards
  as `skillsList` (`:314-319`); doc: "an older daemon, a pod or the worker →
  `MethodNotFound`; a change lasts until the daemon restarts".
- **Why a method** (not SIGHUP / config reload / restart): the phone must reach
  it (decision 4 "in app and TUI"); a signal does not cross the network; the
  TTL is not in the config file today; a restart cuts running turns. The reaper
  stays the single source of truth; no new state elsewhere.

#### Per runtime

| Runtime | `--session-ttl never` | `daemon/session_ttl` |
|---|---|---|
| `serve` | no idle reaping; cap still applies; no interval at all if no cap | read / set, re-armed at once |
| pod (`serve --stdio`), worker | flag not accepted there (it is a `serve` flag, `flags.ts:68`) | `MethodNotFound` (no reaper) |

#### Seam for 2a and later

2a changes what a sweep DOES (archive instead of delete); it builds on
`ReapPolicy.idleTtlMs: number | null`, `sweepIntervalFor` in
`session-reaper.ts`, and the `listen` re-arm in `serve.ts`. Task 7 / 11 add
the UI on `RemoteClient.sessionTtl`.

### Files

In dependency order:

1. `packages/protocol/src/daemon.ts` (new) + `index.ts` export.
2. `packages/protocol/src/methods.ts` — `Method.SessionTtl`, `RequestSchemas`.
3. `packages/protocol/schema/protocol.json` — `bun run schema:export`;
   fixtures in `packages/protocol/test/json-schema.test.ts`
   (`methods/daemon~1session_ttl/params`: `{}`, `{ idleTtlMs: 3600000 }`,
   `{ idleTtlMs: null }`; `/result`: `{ idleTtlMs: null, persisted: false }`,
   `{ idleTtlMs: 86400000, persisted: false }`).
4. `packages/daemon/src/session-reaper.ts` — nullable TTL, `sweepIntervalFor`.
5. `packages/daemon/src/session-host.ts` — `SessionTtlControl` option, `sessionTtl()`.
6. `packages/daemon/src/connection.ts` — dispatch case.
7. `packages/daemon/src/index.ts` — export `sweepIntervalFor`, `SessionTtlControl`.
8. `packages/client/src/remote-client.ts` — `sessionTtl()`.
9. `packages/cli/src/flags.ts` — `never`; `packages/cli/src/main.ts:114` — help.
10. `packages/cli/src/serve.ts` — remove `sweepIntervalFor`, the control, re-arm.
11. Tests (below).

No tui change.

### Failure modes

- **Invalid value** (`0`, `-1`, `1.5`, a string) → `InvalidParams` from the
  peer's params validation; nothing changes.
- **TTL lowered** → re-armed at the new period; the next sweep (≤ new period)
  takes every session already past it. Raised or `never` → nothing taken that
  is not past the new value; the admin cap keeps its own rule.
- **`never` with no admin cap** → no interval at all; `set` to a duration later
  arms one. **`never` with a cap** → interval at the cap's period.
- **Two concurrent sets** → each synchronous; the later wins, both results
  report the value in force right after their own set (each is an honest read).
- **Set during a sweep** → impossible to interleave (load-bearing §).
- **Daemon restart** → the flag's value again (owner Q3); the result's
  `persisted: false` told the caller.
- **Pod / worker** → `MethodNotFound`; a client treats it like an older daemon.
- **A pod lying** (untrusted, §7): it can only lie about its OWN TTL; nothing
  on the laptop acts on the result.
- **Shutdown** → `stop` clears the current interval (not a stale first one).

### Tests

Red first (shown failing on `main`): **F1**, **H1**.

- **F1** (`packages/cli/test/serve-limits.test.ts`, `parseServeLimits`):
  `--session-ttl never` → `{ sessionTtlMs: null }`; `--session-ttl 0s`,
  `--session-ttl nver` still throw; `--session-ttl` alone → "needs a value".
  Red on main ("invalid duration").
- **U1** (`packages/daemon/test/session-reaper.test.ts`, `selectExpired`):
  `idleTtlMs: null` → an idle session never expires; with `adminCapMs` the cap
  still expires a detached one; attached never.
- **U2** `sweepIntervalFor` (moved; the five existing cases at
  `serve-limits.test.ts:26-34` move with it) + `(null)` → `null`,
  `(null, 3000)` → `3000`.
- **H1** (`packages/daemon/test/session-reaper.test.ts` or a new
  `session-ttl.test.ts`, a `SessionHost` over `createChannelPair` + raw
  `RpcPeer`): `daemon/session_ttl {}` reads, `{ idleTtlMs: 5000 }` sets and
  returns `{ 5000, persisted: false }`, `{ idleTtlMs: null }` → `null`;
  `{ idleTtlMs: 0 }` → `-32602`; a host without the control → `-32601`.
  Red on main (`-32601` for every call).
- **S1** (`serve-limits.test.ts`, the existing real-clock short-TTL e2e
  shape at `:143-200`): start with
  `sessionTtlMs: null` → a detached idle session is NOT reaped after a few
  sweeps' worth; `daemon/session_ttl { idleTtlMs: 100 }` over the WebSocket →
  reaped (audit line) shortly after, and an audit `session-ttl never -> 100`.
- **C1** (`packages/client/test/`): `sessionTtl()` round trip; rejects "not
  connected" when down and redialable (copy the `skillsList` test).

Mutations (applied, run, reverted — §9):

| # | Mutation | Must turn red |
|---|---|---|
| M1 | `set` updates `policy` but does not re-arm | S1 |
| M2 | `expiry` ignores `null` (treats as 0) | U1, S1 |
| M3 | `sessionTtl` falls through to `default` (no control) | H1 (`-32601` expected, gets `-32005`) |
| M4 | `flags.ts` maps `never` to the default TTL | F1 |
| M5 | `stop` clears the first interval only | a stop-after-set test in S1 (no audit after stop) |

Validation: `bun run check` green (lint baseline clean, AGENTS §6); the Repro
re-run shows `{ sessionTtlMs: null }` and `daemon/session_ttl` listed.

## Execution

*— claude-sonnet-5-5, 2026-10-24*

### Baseline (before any edit, on `main` 8f7335d + this doc)

`bun run check`: typecheck + lint clean (418 files), **2184 pass / 2 skip / 0 fail**.

### Premises re-verified against today's code (post send-now 4a–4d)

All held: `startReaper` called once, in `listen`; `ReapPolicy` /
`expiry` / `sweepIntervalFor` as cited; `Connection.onRequest` still has the
`SessionList` case and a `default` → `NotInitialized`; `RemoteClient.skillsList`
guard pattern unchanged; `packages/daemon/src/index.ts` does
`export * from "./session-reaper.ts"` and `./session-host.ts`, so
`sweepIntervalFor` / `SessionTtlControl` are exported with no index edit.
Line numbers drifted (the plan's `file:line` are approximate) but no premise broke.

### Repro (on `main`, `.tentacle/tmp/session-ttl-control/repro.ts`)

The plan's repro was stale: `parseArgs(["serve", …])` no longer takes the
command in argv; it is `parseArgs(args, ARGS.serve)`. Fixed script:

```ts
import { ARGS, parseArgs, parseServeLimits } from "../../../packages/cli/src/flags.ts";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";

const parsed = parseArgs(["--session-ttl", "never"], ARGS.serve);
if (!parsed.ok) throw new Error(parsed.error);
try {
  console.log("limits:", parseServeLimits(parsed));
} catch (error) {
  console.log("--session-ttl never ->", (error as Error).message);
}
console.log("protocol", PROTOCOL_VERSION, "methods:", Object.values(Method).join(" "));
```

Before: `--session-ttl never -> --session-ttl: invalid duration "never" (use e.g. 24h, 90m, 45s, 1500ms)`;
`protocol 10 methods: initialize … skills/list hooks/trust` (no TTL method).
After: `limits: { sessionTtlMs: null }`; methods now include `daemon/session_ttl`
(`… skills/list daemon/session_ttl hooks/trust`).

### As built (plan order)

1. **Red tests first**, run on unmodified source: F1 (`serve-limits.test.ts`,
   fails `invalid duration "never"`), U1 (`session-reaper.test.ts`, assertion
   red: idle row reaped/mis-evaluated), H1 (`daemon/test/session-ttl.test.ts`,
   `Received: -32601` where `-32602`/results were expected). U2
   (`daemon/test/sweep-interval.test.ts`) is red as a load error
   (`Export named 'sweepIntervalFor' not found in session-reaper.ts`) — a
   missing export cannot fail on an assertion; accepted.
2. **Protocol**: `packages/protocol/src/daemon.ts` (new; `SessionTtlParams/ResultSchema`
   exactly as in the plan), `index.ts` export, `methods.ts` (`Method.SessionTtl`
   + `RequestSchemas`), `schema/protocol.json` via `bun run schema:export`
   (+48 lines), fixtures in `json-schema.test.ts`. No `PROTOCOL_VERSION` bump
   (method is additive, v10 forward-compat).
3. **Daemon**: `session-reaper.ts` — `ReapPolicy.idleTtlMs: number | null`,
   `expiry` idle branch only when non-null, `sweepIntervalFor(number | null, cap?)
   : number | null` moved here; `session-host.ts` — `SessionTtlControl`,
   `SessionHostOptions.sessionTtl?`, `SessionHost.sessionTtl()` (absent control →
   `RpcError(MethodNotFound)`); `connection.ts` — `case Method.SessionTtl` after
   the `initialized` gate.
4. **Client**: `RemoteClient.sessionTtl(idleTtlMs?: number | null)`, guards as
   `skillsList`; new `client/test/session-ttl.test.ts` (C1 + older daemon,
   invalid value, garbage result, link down).
5. **CLI**: `flags.ts` (`never` → `null`, type widened), `main.ts` help,
   `serve.ts` (below).
6. Tests moved/added: the five `sweepIntervalFor` cases moved from
   `serve-limits.test.ts` to `daemon/test/sweep-interval.test.ts` (+ the `null`
   cases); S1 (four e2e tests) added to `serve-limits.test.ts`.

### Nuances decided (all of them)

- **`flags.ts`: exact lowercase `never` only.** `Never`/`NEVER`/`forever` stay
  "invalid duration". `never` is accepted for `--session-ttl` ALONE;
  `--session-admin-cap never` and `--ws-idle-timeout never` still throw (test).
  `--session-ttl` with no value is still "needs a value" (the `never` check
  looks at `flags.get`, which is undefined for a bool, so it falls through to
  `duration()` → throws).
- **`sweepIntervalFor` with `null` TTL**: `bound = idleTtlMs ?? adminCapMs`;
  none → `null`; else `max(1 s, min(60 s, bound, cap ?? bound))`. So
  `(null, 24 h)` → 60 s, `(null, 1)` → 1 s floor.
- **`sweepIntervalMs` test override counts as "non-null"** (per the plan):
  with the override, `never` + no cap still arms an interval (it sweeps with
  nothing to do). Production never sets it. This is what lets S1 test
  M1 (re-arm) with a 20 ms period.
- **`arm()` after `stop`**: a `stopped` flag makes `arm()` a no-op once the
  daemon is stopping, so a `daemon/session_ttl` arriving during shutdown cannot
  leak a fresh interval. (Not in the plan; the plan only required `stop` to
  clear the current one.)
- **Audit line**: `session-ttl <old> -> <new>` with `never` or `<n>ms`
  (e.g. `session-ttl never -> 100ms`), emitted in `set` BEFORE the policy swap,
  also when the value is unchanged (no de-dup).
- **A no-op set re-arms too** (same value): harmless, keeps `set` trivially
  simple; the interval period restarts. **WRONG — superseded by follow-up 1,
  item 1:** it starved the sweep.
- **`BoundSessionTtl`** (a small class in `serve.ts`): the host is built
  before `listen`, so it receives a forwarder that `listen` binds; using it
  unbound throws (programming error, as the plan said). The bind happens in the
  same synchronous run as `startWsServer`, so no request can see it unbound.
- **`null` allowlist in the wire-hygiene test**: `json-schema.test.ts` "null
  appears only where it carries meaning" lists every `null` site. The two new
  sites (`SessionTtlParams/…/idleTtlMs`, `SessionTtlResult/…/idleTtlMs`) were
  added to it with the reason (null = never). The plan did not foresee this.
- **Invalid values** (0, −5, 1.5, a string, > `MAX_SAFE_INTEGER`) are rejected
  by the peer's params validation (`-32602`) before the host: asserted at
  daemon, client and e2e level; nothing audited, nothing changed.
- **`persisted` is `z.literal(false)`** as planned.
- **Pods / worker**: no `sessionTtl` option → `MethodNotFound` (tested at
  host level and via the client). Nothing in `startStdioDaemon` / the worker
  changed.
- **`ReapPolicy` comment** says `null` = never; the reaper file header was not
  rewritten (still accurate).
- **No docs change** beyond the help string: `README.md` / `ARCHITECTURE.md`
  do not mention `--session-ttl`.

### Mutations (AGENTS §9) — applied, run, reverted

| # | Mutation | Result |
|---|---|---|
| M1 | `set` swaps `policy` but skips `arm()` | red: both S1 reaper tests (`never keeps…re-arms`, `never with no cap…starts one`) |
| M2 | `expiry` treats `null` as 0 (`>= (idleTtlMs ?? 0)`) | red: U1 and S1 (`never keeps…`) |
| M3 | no `case Method.SessionTtl` (falls to `default`) | red: H1 `{}…` and `MethodNotFound` tests (`Received: -32005`) + 3 client tests |
| M4 | `flags.ts` maps `never` to `undefined` (default TTL) | red: F1 |
| M5 | `stop` no longer clears the current reaper | red: the new stop-after-set test AND the pre-existing `stop() stops the reaper too` |
| M6 (extra) | `sweepIntervalFor` `null` case falls to 60 s | red: U2 `never:` test |

M5 as applied removes the `stopReaper?.()` call from `stop` rather than
keeping a stale first handle: the property is the same (the CURRENT interval
must be cleared by `stop`). After the last revert,
`shasum` of `serve.ts`, `session-reaper.ts`, `connection.ts`, `flags.ts`,
`session-host.ts` equals the hashes taken before M2 (the tree was verified
byte-identical; `git status --short | shasum` = `290ee58e…` before and after
M2–M5). M1 was applied before the reference hashes existed; its revert is the
exact inverse edit and the full suite passed afterwards.

C1 (client) was written after the client code, so it was not run red on
`main`; its non-vacuity is covered by M3 (3 client tests turn red).

### Gate

- Baseline: 2184 pass / 2 skip / 0 fail; lint clean.
- Final `bun run check`: typecheck clean, `biome check .` (422 files) clean,
  **2200 pass / 2 skip / 0 fail** (+16 tests). One lint round: the first run
  flagged a formatting error in `serve.ts` (the audit line wrapped), fixed
  with `biome check --write packages/cli/src/serve.ts`.
- Known GC flake ("a connection forgets a session another client closed",
  TODO.md) showed once in a narrow run, not in the full gate.

### Drift from the plan

- Repro script corrected (`parseArgs` signature).
- Added: `stopped` guard in `arm()`; the `null` allowlist entries in the
  wire-hygiene test; `never` rejected for the other duration flags (explicit
  test); extra mutation M6; U2 lives in a separate file
  (`sweep-interval.test.ts`) to keep U1's red on an assertion.
- Not changed: no `PROTOCOL_VERSION` bump, no tui change, no persisted format.

### Unverified

- Real end-to-end with a phone / the TUI: nothing in the TUI calls
  `sessionTtl` yet (tasks 7 / 11). Verify then.

## Review

*— claude-opus-5-5, 2026-10-24 (fresh context; a different model from the
executor claude-sonnet-5-5, but the same family: shared blind spots possible)*

### Verdict: REQUEST-CHANGES

The design is sound and the wiring is right (both ends, JSON Schema, no
bump needed, pods/worker unaffected). One finding is a real defect, and it
leaves a wrong state with no error: a stream of `set`s turns the reaper off,
admin cap included. It needs a small fix and a test. The rest are nits.

### Findings

1. **MEDIUM: every `set` re-arms the interval, so repeated sets stop the
   sweep from ever running.** At `packages/cli/src/serve.ts:238-243`, `set`
   always calls `arm()` (`:220-233`). That clears the interval and starts a
   new one, so the period starts over each time. That includes a no-op set
   to the same value. Any client that sets more often than the period (60 s
   in production; a UI that re-applies its preference on each reconnect, or
   a slider) means no sweep ever happens. Neither the idle TTL nor the
   **admin cap** fires. The admin cap is the operator's safety bound, and
   `never` deliberately keeps it. So a caller can defeat it, which the method
   is not meant to allow. The plan's failure mode "TTL lowered → the next
   sweep (≤ new period) takes it" does not hold. The Execution note "a no-op
   set re-arms too: harmless" is wrong.
   *Evidence* (the real `startDaemon` over a socket, `.tentacle/tmp/session-ttl-control/starve.ts`):
   `never`, one detached session, then `{idleTtlMs:100}` every 400 ms for
   5 s (derived period 1 s) → `after 5 s of repeated sets, reaped? false`.
   After the sets stop → `session-reaped … idle_ttl` at 5512 ms.
   *Fix direction*: re-arm only when the derived period changes, or when
   switching between interval and no interval. Have the running sweep read
   the current `policy` (a getter) rather than a captured copy, so a
   same-period change needs no re-arm. Add a test where repeated sets still
   reap.
2. **LOW: the `stopped` guard (`serve.ts:219`, `:226`, `:252`) is not
   tested.** I found this by accident: one of my mutation reverts dropped
   `stopped = true;`, and `serve-limits.test.ts` stayed **15/15 green**. I
   restored it; the hashes match below. The scenario it covers is a set that
   arrives after `stop()` and starts a new interval. Add a test: `stop()`,
   then a set through the bound control (or a request that is still in
   flight), and assert that nothing is reaped.
3. **LOW (doc / 2a–7 seam): "widening `persisted` to `z.boolean()` is
   additive in meaning" (Implementation › Wire) is false.** The client
   validates the result (peer schema). With `z.literal(false)`, an older
   client would reject `persisted: true` as an invalid result. That is a
   changed meaning, so it needs a `PROTOCOL_VERSION` bump (AGENTS §7). This
   is fine for now. Fix the sentence so that whoever adds persistence
   later knows a bump comes with it.
4. **NIT: the params have three states.** No field means read, a number
   means set, and `null` means never. A client written as
   `{ idleTtlMs: v ?? null }` meant to read but sets `never` instead. The
   wire-hygiene allowlist names this, which is acceptable. Point it out to
   the task 7/11 UI author.
5. **NIT: "never with no cap runs no interval" (`serve-limits.test.ts`)
   does not check that there is no interval.** It only checks that a later
   set reaps. The `sweepIntervalFor → null` rule is covered by the U2 unit
   test (M6). The `arm` branch that skips `startReaper` on `null` is not
   pinned end to end. I did not mutate it.

### Gate (re-run by the reviewer)

`bun run check`: typecheck clean · `biome check .` 422 files, clean ·
**2200 pass / 2 skip / 0 fail** (2202 tests, 178 files). This matches
Execution. The 2 skips are the opt-in ones. No GC flake in this run.

### Mutations (reviewer, applied → run → reverted)

| Mutation | Result |
|---|---|
| M1: `set` swaps `policy` without calling `arm()` | red: 2 S1 tests (never…re-arms, never-no-cap…starts one) ✓ (executor's revert re-proved) |
| M5′: `stop` clears the handle from the **first** arm (the stale-handle mutation from the plan, which the executor did NOT apply) | red: only "stop() after a change stops the CURRENT reaper" ✓, so the new test is not vacuous |
| `stopped = true` dropped (unintended, see F2) | **green 15/15**: the guard is not tested |
| M3: no `case Method.SessionTtl` | red: 2 daemon (H1) + 3 client tests ✓. C1 is not vacuous, though it was never run on `main` |
| M2: `expiry` treats `null` as 0 | red: U1 + S1 ✓ |

Tree after all reverts: `git status --short | shasum` = `290ee58e…`,
`git diff | shasum` = `90bc1935…`, and the 4 untracked files' `shasum`s are
identical to the values taken before the review. **Byte-identical.**
I did NOT re-run F1/H1/U1 on `main`: that would mean stashing, which touches
the tree. I accept them on the code. On `main` the peer answers -32601 for an
unknown method (`transport/src/peer.ts:333-335`), and `parseDuration` rejects
`never`.

### Premise table

| Premise | Verdict |
|---|---|
| Repro script (Context) | **FALSE as written**: `parseArgs` now takes `ARGS.serve`. The executor caught and fixed this. Symptom confirmed by the code |
| `startReaper` has one call site, in `listen`; the policy is captured by the interval closure | TRUE (`session-reaper.ts:123-145`); this capture is why F1 re-arms at all |
| `SessionHost` / ws-server cache no TTL | TRUE (grep: only `serve.ts` holds the policy) |
| A sweep is synchronous, so a set can't land inside one | TRUE (`session-host.ts:295-312`) |
| Unknown method → `MethodNotFound` before any handler; params validated by the peer | TRUE (`peer.ts:333-341`) |
| `Connection` `default` → `NotInitialized`, so an explicit case is needed | TRUE (`connection.ts:190`) |
| Pod / worker build `SessionHost` without the control | TRUE (only `startDaemon` passes `sessionTtl`) |

### Attacks tried

- **Value validation over the wire** (real socket): `0`, `-5`, `1.5`, `"1h"`,
  `"never"` (string), `MAX_SAFE+1` → -32602, nothing audited or changed
  (tests + trace). `1e15` → accepted; the period clamps to 60 s, no overflow
  in `setInterval`. Holds.
- **`never` case-sensitivity / scope**: only exact lowercase `never`, and
  only on `--session-ttl` (`Never`, `forever`, `--session-admin-cap never`
  throw). Holds.
- **Older daemon / pod / worker**: the peer and `SessionHost` answer -32601,
  and the client maps it (tests). Reverse direction: a pod sending
  `daemon/session_ttl` TO the laptop gets `MethodNotFound`
  (`client/src/remote-client.ts:662`), so it gains nothing on the laptop
  (§7 untrusted pod). Holds.
- **No bump: honest?** Yes. The method is new, and a peer that does not know
  it answers `MethodNotFound`. No existing field or meaning changed. Holds
  (but see F3 for the later widening).
- **Peer serialization (§7)**: the handler is synchronous with no await and
  no lock; two concurrent sets are ordered and the last wins. Holds.
- **Repeated sets / timer churn**: **FOUND F1.**
- **Shutdown**: a stale-handle `stop` is caught by the new test. A set after
  `stop` is guarded but untested (**F2**).
- **Authorization**: any token holder may change a daemon-wide TTL. This is
  consistent with `session/close` (one token = one principal, per-device auth
  is task 9). Accepted; F1 makes it slightly worse (cap bypass).
- **2a seam**: `ReapPolicy.idleTtlMs: number | null`, `sweepIntervalFor` in
  `session-reaper.ts`, and the `listen` owner are additive. Nothing archives,
  no record or protocol bump is pre-empted. Holds.

### What holds

The protocol is wired at both ends, plus the JSON Schema and null-site
allowlist. `null` = never through flag → policy → expiry → sweep period.
`persisted: false` follows the owner's decision. Nothing is persisted, so
the flag wins at restart. The admin cap still applies under `never`. The
pod and worker paths are unchanged.

### How the executor behaved

The executor behaved well overall and reported honestly. They fixed the
stale repro, recorded every deviation (the `stopped` guard, the allowlist,
U2 in its own file), and admitted that C1 was written after the code and
that M1 was reverted without hashes. Two weak spots. First, M5 was applied
as a different, weaker mutation (removing the call) than the one the plan
named, the stale first handle. That mutation also turns the old test red,
so it did not show that the new test is needed. My M5′ shows it is. Second,
"a no-op set re-arms too: harmless" was asserted without a test, and it
hides F1. The new `stopped` guard shipped with no test of its own.

## Execution — follow-up 1

*— claude-sonnet-5-5, 2026-10-24*

Answers the Review's REQUEST-CHANGES (Review itself untouched). Order: item 4
(wire shape, tests first), then 1, 2, 5, then 3 (doc).

### Item 1 (MEDIUM) — a `set` no longer restarts the sweep timer

Root cause: `arm()` stopped and restarted the interval on every `set`, so a
client setting more often than the period (1 s floor … 60 s) pushed the next
sweep later each time; neither the idle TTL nor the admin cap ever fired.

Fix (`packages/cli/src/serve.ts` `listen`, `packages/daemon/src/session-reaper.ts`):
- `startReaper` takes `policy` as a value OR a function read at every sweep,
  so a change that keeps the period needs no restart; new option
  `firstSweepInMs` (the first sweep on its own delay, then every
  `sweepIntervalMs`; `stop` clears the timeout and the interval).
- `listen` tracks `armedMs` (the running period, `null` = none) and
  `lastSweepAt` (a `Reapable` wrapper stamps each sweep). `arm()` does nothing
  when the wanted period equals `armedMs`. Only a period change (or none ↔
  some) restarts, and then the new reaper's first sweep is
  `min(newPeriod, max(0, lastSweepAt + oldPeriod − now))`: **the next sweep is
  never later than it was due** (the phase is kept). From "no timer" the first
  sweep is a full period, as before.
- Nuance: a period change that is SHORTER than the old remaining time sweeps at
  the new period; one that is LONGER sweeps at the old due time first (a
  possibly early extra sweep, harmless: sweeping is idempotent).

Red (before the fix, same code as the first Execution): two new tests in
`cli/test/serve-limits.test.ts` — (a) the reviewer's repro: `never`, then
`{ idleTtlMs: 100 }` every 400 ms, the session must be reaped before 3 s
(`Expected to contain "session-reaped … idle_ttl"` — starved for 3.7 s);
(b) sets alternating TTL 1200/1300 ms (so the period changes every 300 ms),
same assertion (red, 4.1 s).

Mutations (all reverted; `shasum` of `serve.ts` + `session-reaper.ts`
identical to the pre-mutation hashes after each round; `git status --short |
shasum` unchanged):

| Mutation | Result |
|---|---|
| A2: no early return AND no `firstSweepInMs` (= the old unconditional, fresh-phase restart) | red: (a) and (b) |
| B: early return kept, `firstSweepInMs` dropped (a period change loses the phase) | red: (b) only |
| A1: early return removed, `firstSweepInMs` kept (restart but keep the phase) | **green on (a)/(b)**: phase preservation alone already prevents starvation. Killed by the new timer-count test below (it sees the stop/start) |
| E: sweep reads a policy snapshot, not the live one | red: `--session-ttl never keeps…re-arms at once` |

### Item 2 (LOW) — the `stopped` guard

New test "a set that arrives while the daemon stops starts no new reaper":
the test's `onAudit` runs inside `set` (before its `arm()`), and stops the
daemon there — "a set in flight at stop". It then waits 2.5 s (two floor
periods) and asserts no `session-reaped`. Mutation C (drop `stopped ? null :`
in `arm`): red (the set re-armed after stop and reaped). Green restored.

### Item 5 (NIT) — "no interval" is now asserted

The test "never with no cap starts no sweep timer at all…" wraps
`globalThis.setInterval/clearInterval` (restored in `finally`) and counts the
timers of the reaper's periods (1000 / 60000 ms): none on boot with
`never` and no cap; one (1000 ms, the floor) after `{ idleTtlMs: 1 }`; a set
to the same period starts and clears nothing (kills A1); `"never"` clears it
and starts none. Mutation D (`arm` starts a 60 s reaper when the period is
`null`): red. (It was already true before; the test pins it.)

### Item 4 (NIT) — unambiguous params

Chose the literal `"never"` over `null` (no separate read method: one method,
absent = read, is simpler and a read is still `{}`): **`idleTtlMs` is
`number | "never"`, `null` is invalid** (`-32602`), so a client's
`v ?? null` fails loudly instead of silently setting `never`. The **result**
also says `"never"` (not `null`): one spelling on the wire, and the
wire-hygiene `null` allowlist in `json-schema.test.ts` is back to its original
two entries (my earlier two additions removed). Changed:
`protocol/src/daemon.ts` (a small `idleTtl()` factory — the JSON Schema export
refuses one anonymous schema reused in two places), `protocol/schema/protocol.json`
(regenerated), `daemon/src/session-host.ts` (`"never"` ↔ `null` at the host
boundary; `SessionTtlControl` and `ReapPolicy` keep `null`),
`client/src/remote-client.ts` (`sessionTtl(idleTtlMs?: number | "never")`),
and the tests (fixtures `{ idleTtlMs: "never" }`; `null`, `"Never"`, `0`, `-1`,
`1.5`, `"5s"` and `> MAX_SAFE_INTEGER` asserted `InvalidParams`). Red first:
the tests were switched to `"never"` before the source (5 failures), then
green. Still no `PROTOCOL_VERSION` bump: the method has not shipped, so its
shape is free to change (AGENTS §7, pre-public). **For the task 7 / 11 UI
author:** read with no argument; `"never"` is a word, never `null`.

### Item 3 (LOW, doc) — `persisted` widening

The Implementation sentence "widening to `z.boolean()` is additive" was
wrong: an older client validates the result and rejects `persisted: true`. It
is corrected in place (Implementation › Wire) and in the `daemon.ts` comment:
**persisting a runtime TTL needs a `PROTOCOL_VERSION` bump. Note for 2a**
(which bumps 10→11 anyway): if a persisted TTL is wanted, change `persisted`
to `z.boolean()` there, in the same bump. The wrong "no-op set re-arms:
harmless" bullet in the first Execution is marked superseded.

### Gate

`bun run check`: typecheck clean · `biome check .` (422 files) clean ·
**2204 pass / 2 skip / 0 fail** (+4 tests over the first Execution's 2200:
two starvation, the `stopped` guard, the timer count; the older tests were
edited in place). Baseline for the whole task: 2184.

### Not verified

- The phase logic across THREE+ consecutive period changes is covered by test
  (b) (alternating, many changes) but only for sweeps ≥ 1 s apart; sub-second
  periods do not exist (1 s floor) except through the `sweepIntervalMs` test
  override.
- No unit test for `firstSweepInMs` in isolation (`startReaper`); it is covered
  end to end (mutation B).

## Review — round 2

*— claude-opus-5-5, 2026-10-24 (same fresh reviewer context as round 1;
executor claude-sonnet-5-5: a different model, the same family)*

### Verdict: REQUEST-CHANGES (one small defect: the phase claim is false)

Round 1's findings #2–#5 are closed, each checked with my own mutation.
#1's starvation is fixed. But the property this fix advertises in bold, "the
next sweep is never later than it was due", is **false**. It fails when two
period changes land while the replacement reaper's first sweep is still
pending. The delay has a bound, and it is not starvation. Still, the
invariant stated in the code comment and in the doc does not hold, and the
fix takes a few lines.

### Findings

1. **LOW–MEDIUM: the kept phase is computed from the wrong time.** At
   `packages/cli/src/serve.ts:249`, `due = lastSweepAt + armedMs` assumes
   the running reaper's next sweep comes one full period after the last
   sweep. A reaper started by a previous change is first waiting on
   `firstSweepInMs`: its real next sweep is that shorter timeout, and
   `lastSweepAt` has not moved since. A second period change then
   recomputes `due` with the newer, longer period and pushes the sweep that
   was already scheduled past its due time.
   *Evidence* (`.tentacle/tmp/session-ttl-control/phase.ts`, the real
   `startDaemon`, `SessionHost.prototype.reapExpired` stamped): TTL 1000
   (sweep due at ~1000 ms). At 500 ms set 5000 → due kept at ~1000. At
   800 ms set 4000 → **the only sweep ran at 4803 ms**, not at ~1000.
   *Bound*: `firstSweepInMs ≤ wanted` and `due ≤ lastSweepAt + 60 s`. So a
   sweep still happens within one new period of the latest change and
   within 60 s of the previous sweep: there is no starvation and the admin
   cap is safe. A late sweep is ≤ 59 s (1 s → 60 s → 59 s chain).
   *Not caught*: test (b) "repeated sets that CHANGE the period do not push
   the next sweep later than it was due" passes with this bug present. It
   asserts the session is reaped eventually, not when the sweep runs.
   *Fix direction*: track the real `nextSweepAt`. Set it to
   `now + (firstSweepInMs ?? period)` on arm and to `now + period` at each
   sweep, and use `due = nextSweepAt`. Add a test that pins the sweep time
   in the chained case, like my repro. Also fix the comment at `:231-237`.
2. **NIT: `startReaper`'s first-sweep timer cannot be injected.**
   `firstSweepInMs` uses the global `setTimeout`/`clearTimeout`
   (`session-reaper.ts`, the `first` timer), although `ReaperOptions`
   offers injectable `setInterval`/`clearInterval`. A fake-timer unit test
   of the phase logic (the cheap way to close F1) cannot drive it. Add
   `setTimeout`/`clearTimeout` to the options.

### Round-1 findings: status

| # | Status | Reviewer's mutation → result |
|---|---|---|
| 1 starvation | **closed** (the phase part: F1 above) | R1: back to the unconditional, fresh-phase restart (no early return, no `due`) → red: "repeated sets with the same period…", "repeated sets that CHANGE the period…", "never with no cap starts no sweep timer…" ✓. Round-1 repro re-run: sweeps at 1025/2025/3026/4027 ms under `set 100` every 400 ms, session reaped at 1027 ms (was: never) |
| 2 `stopped` guard | **closed** | R2 (`stopped ? null :` dropped) → red: "a set that arrives while the daemon stops starts no new reaper" ✓ |
| 3 `persisted` widening | **closed** | Corrected in `protocol/src/daemon.ts` (`persisted` comment) and Implementation. Doc only, read |
| 4 three-state params | **closed** | R3 (params `idleTtl().nullable()`) → red: daemon "invalid value is InvalidParams", schema drift gate, null-site allowlist ✓. Over the socket: `{idleTtlMs:null}` → -32602. Both ends wired: `SessionHost.sessionTtl` maps `"never"` ↔ `null`, `RemoteClient.sessionTtl(number \| "never")`, `protocol.json` has `"const": "never"` in params and result, fixtures updated |
| 5 "no interval" not asserted | **closed** | R2's other half (`sweepIntervalFor(…) ?? 60000`) → red: "never with no cap starts no sweep timer at all…" ✓ |

**No bump for #4: honest.** `daemon/session_ttl` has never been in a
release or on `main`. It changes shape inside its own unmerged branch, so
no peer anywhere knows the `null` form. To an older daemon the method is
still additive (`MethodNotFound`, `transport/src/peer.ts:333-335`). The one
place `null` is used, the daemon's internal `ReapPolicy`/`SessionTtlControl`,
is not on the wire.

### Gate (re-run)

`bun run check`: typecheck clean · `biome check .` 422 files, clean ·
**2204 pass / 2 skip / 0 fail** (2206 tests, 178 files). This matches
follow-up 1.

### Attacks tried (round 2)

- **Repeated same-period sets** (round-1 repro): fixed, see the table. Holds.
- **Two chained period changes in the first-sweep window**: **FOUND F1.**
- **Double sweep?** A period change clears both the old first-sweep
  timeout and the old interval before arming (`session-reaper.ts` `stop`
  returns clear-both), so the two reapers never overlap. When `due` is
  already past, `firstSweepInMs = 0` sweeps at once: an *early* extra sweep,
  as the follow-up says. That is harmless: sweeps are idempotent and are
  bounded by the request rate. Holds.
- **Set after stop**: `wanted = null` ≠ `armedMs` → clears (idempotent)
  and arms nothing. Holds (R2).
- **never → duration → never → duration**: `armedMs = null` clears it, and
  from "no timer" the first sweep is a full period
  (`due === undefined`, `lastSweepAt` reset at `:263`). Holds (timer-count
  test).
- **Policy read live**: the sweep reads `() => policy` each time, so a
  same-period change needs no restart. Holds (executor's mutation E; my R1
  confirms the early return is load-bearing via the timer-count test).

### Tree

All mutations were reverted. Tracked files: `git status --short | shasum`
= `290ee58e…`, `git diff | shasum` = `e9606c1c…` (equal before and after).
`packages/protocol/src/daemon.ts` is untracked: I reverted it with the exact
inverse edit, and the schema drift gate against the unchanged committed
`protocol.json` is green (25/25). Hash now `f9286214…`.

### How the executor behaved

Their response to round 1 was good. They wrote the tests red first, reported
the A1 mutation honestly (green on the starvation tests, killed only by the
timer-count test), and listed unverified points. One miss: the headline
invariant was asserted in bold and "pinned" by test (b), which does not
check the property it is named after: it checks the session is reaped, not
when the sweep runs. That is the AGENTS §2/§9 trap, proving a correlated
property instead of the exact one. Their own "Not verified" note on
three-or-more consecutive changes was the right instinct. This defect is
the two-change case.

## Execution — follow-up 2

*— claude-sonnet-5-5, 2026-10-24*

Answers "Review — round 2" (Review untouched).

### Item 1 — the real next sweep time

Root cause (as the reviewer said): `due = lastSweepAt + armedMs` assumed the
running reaper's next sweep is one full period after its last sweep. A reaper
still waiting on its shorter `firstSweepInMs` has an earlier real due time; a
second period change recomputed it from the newer, longer period.

Fix (`packages/cli/src/serve.ts`, `listen`): `lastSweepAt` is replaced by
`nextSweepAt`, the ABSOLUTE time of the running reaper's next sweep.
- Each sweep (the `Reapable` wrapper) sets `nextSweepAt = now + armedMs`.
- `arm()` on a change computes `firstSweepInMs = min(wanted, max(0, nextSweepAt - now))`
  when a reaper was running, else a full `wanted`, and stores
  `nextSweepAt = now + firstSweepInMs`. So the pending due time survives any
  number of changes before it runs: it is `min(earliest due, now + new period)`.
- The comment on `arm` now says that (it said "the old one's due time").

Red first (same pre-fix code): new test "two period changes before the
replacement's first sweep: the sweep still runs when it was first due"
(`cli/test/serve-limits.test.ts`). Reviewer's repro on the real `startDaemon`:
TTL 1000; at 500 ms set 5000; at 800 ms set 4000;
`SessionHost.prototype.reapExpired` is spied (restored in `finally`) to
record WHEN a sweep runs — the exact property, not "the session is reaped
eventually". Asserts the first sweep is in [900, 1800) ms. Pre-fix:
`Expected: < 1800  Received: 4802`. Post-fix: green. Test (b) never tested
this (it passed with the bug); it stays as the starvation test.

Mutation (reverted; `shasum` of `serve.ts` + `session-reaper.ts` identical to
the pre-mutation hashes, `git status --short | shasum` unchanged):
`nextSweepAt = now + wanted` on arm (recompute from the last arm = the
reviewer's failure) → red: the new test (`Received: 4802`) AND test (b).

### Item 2 — injectable first-sweep timer

`ReaperOptions.setTimeout` / `clearTimeout` (`session-reaper.ts`), defaulting
to the globals, used for the `firstSweepInMs` timer like the interval. New
fake-timer unit test in `session-reaper.test.ts` ("firstSweepInMs: …"):
the first sweep runs on the injected timeout (no interval before it), the
interval starts only after it, the policy function is read at the sweep (not
captured at start), `stop` before the first sweep clears only the timeout, and
`stop` after it clears the interval. Mutation (the first timer back on the
global `setTimeout`) → red; reverted, hashes identical. The test was written
together with the option, so there was no red-on-`main` run for it; the
mutation is its non-vacuity proof.

### Nuance

Nothing is stored for a stopped reaper (`wanted === null`): `nextSweepAt` is
stale then, but the next arm from "no timer" ignores it (full period).

### Gate

`bun run check`: typecheck clean · `biome check .` clean · **2206 pass / 2
skip / 0 fail** (+2: the phase test and the `startReaper` fake-timer test;
2204 after follow-up 1, 2184 baseline).
