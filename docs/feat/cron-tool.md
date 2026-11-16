# feat/cron-tool — the agent schedules its own wake-ups (recurring or one-shot)

> **Status:** implementation — **Implementation APPROVED by the owner (2026-11-16)**, answers below (#### Owner answers)
> **Branch:** `feat/cron-tool`
> **Size:** L as a whole → slices S1–S6 below, each S or M · **Blast:** load-bearing (the daemon starts model turns on its own clock inside `HostedSession`'s one busy slot; it adds a field to the trusted `serve` sidecar, a protocol update + method, and a trust bit on the worker's client — AGENTS §7 persistence, single broker, a pod is not trusted, protocol) · **Suited:** S1, S5, S6 any executor + standard Review; S2–S4 a strong executor; **mandatory fresh-context Review** of the branch red-teaming the busy slot, the ask-with-nobody-attached rule, the sidecar version and the pod exclusion. The owner assigns executors.
> **Changelog:** `changelog.d/cron-tool.added.md` — `- **The agent can schedule its own wake-ups.** Ask it to "check the build every 10 minutes" or "remind me at 17:00": it registers a scheduled wake (recurring or one-shot) that starts a turn with a short prompt when it is due. \`/schedule\` (and Session info on the iPhone) lists them and deletes one; on \`serve\` they survive a daemon restart, in a local session they last until you quit.`

## Context

*— claude-opus-5-5, 2026-11-15*

**Owner request (2026-11-16).** "A tool_call cronjob: the agent registers a
cron job that runs every X time and WAKES it with a small
prompt/reminder/action" — the shape of Claude Code's
`CronCreate`/`CronList`/`CronDelete` + `ScheduleWakeup`: recurring or one-shot,
a short prompt enqueued at fire time, list and delete, auto-expiry.

**What exists today (verified on `feat/cron-tool` @ `4164c835`, = `main`).**
The only autonomous turn is the **job-exit wake**, in three places that share
one pure rule:

- pure rule: `packages/core/src/auto-wake.ts:35` `wakeDue(model, gate)`, `:56`
  `daemonWakeGate` (the `serve` daemon's gate: `enabled`, `busy`, `lastEndBad`,
  `closed`);
- `serve` daemon: `HostedSession.kickWake` (`packages/daemon/src/hosted-session.ts:2816`,
  a macrotask, one pending) → `maybeWake` (`:2833`) → `prompt("wake-<uuid>", [])`
  (`:2846-2858`); triggers: a job exit, a turn's end (`finishTurn` `:2807`, after
  the steering window), a compaction's end (`:3093`); on only when
  `SessionHostOptions.wakeOnJobExit` (`session-host.ts:338`), set by `serve`
  alone (`packages/cli/src/serve.ts:764`);
- laptop TUI (worker, pods): `packages/tui/src/wake-gate.ts:56`; detached relay:
  `packages/cli/src/relay-state.ts:210` `relayWakeDue`.

Nothing in the tree schedules a turn by time. Every timer is about liveness or
UX (reaper sweep, title kick, wake kick, keepalive).

**Repro (feature missing), 2026-11-15, from the worktree:**
```
$ git rev-parse --short HEAD
4164c835
$ rg -n -i "cron|schedul" packages/tools/src packages/protocol/src/updates.ts \
    packages/daemon/src/hosted-session.ts packages/daemon/src/daemon-state-file.ts
packages/daemon/src/hosted-session.ts:700:  /** A title request scheduled at a turn's end …
packages/daemon/src/hosted-session.ts:707:   * A wake check scheduled (a macrotask): …
packages/daemon/src/hosted-session.ts:1300:      this.persister.schedule(this.id, …
packages/daemon/src/hosted-session.ts:1885:      // Durable NOW (a `schedule`: …
packages/daemon/src/hosted-session.ts:2803:      // Only SCHEDULES (a macrotask): …
packages/daemon/src/hosted-session.ts:2806:      // wakes for it. Scheduled too.
packages/daemon/src/hosted-session.ts:3092:      // An exit that came while the slot was the compaction's (scheduled).
packages/tools/src/search-tool.ts:159:  // every `explore` child a "writer" for the round scheduler.
```
No tool, no update type, no sidecar field: the only hits are the word
"schedule" used for the persister and macrotasks. The model has no way to be
woken by time. (The executor re-runs this first; S3's red test T-D1 is the
behavioural repro.)

**Constraints (AGENTS §7).**
- One session path: a fire is the SAME `HostedSession.prompt()` a client uses,
  through the same busy slot. No second turn driver.
- Logic in pure modules: parsing, next-fire, catch-up, caps and expiry live in
  `@tentacle/core`, unit-tested without timers.
- Single broker: creating a schedule and every tool call of a fired turn ask
  through the session's broker. Nothing new may answer an ask.
- Persistence: `serve` (trusted) persists; pods and the worker never do.
- A pod is not trusted: a pod-registered schedule must never create a lasting
  approval on the laptop or make the laptop start turns by itself.
- Protocol: additive where possible (a display update + a method + optional
  fields are free, §7 forward compat). No `protocol.d/` note unless something breaks.

## Implementation

*— claude-opus-5-5, 2026-11-15*

### Load-bearing assumption

**A `HostedSession` can start a turn by itself, by time, with a NON-empty
prompt, through `prompt()`, race-free against clients, and every existing rule
(busy slot, held asks, persistence, the reserved `wake-` id) applies unchanged.**
Proof:

- `prompt(turnId, content, …)` (`hosted-session.ts:2262`) is synchronous up to
  the ack. It takes the slot through `assertIdle()` (`:2285`, defined `:2621`),
  so a fire and a client prompt can never both run. The job-exit wake already
  calls it with no request (`:2858`). A non-empty text is the ordinary case.
  The text joins the history as a user message (`Session.send`), and the turn's
  start flushes every pending job exit too (agent flush at turn start,
  `docs/feat/serve-autowake.md` P2). So a fire and an exit wake due together
  are ONE turn.
- The id `wake-<uuid>` is reserved for daemon-minted turns:
  `WAKE_TURN_PREFIX`/`isWakeTurnId` (`packages/protocol/src/session.ts:311-315`),
  refused from clients in `connection.ts:1037-1040`. A `connect` client
  auto-accepts that turn's asks only because it trusts its daemon
  (`daemonWakes: true`, `packages/cli/src/connect.ts:231`;
  `docs/fix/autoaccept-wake-turns.md` A3-A5). A fire minted with the same prefix
  inherits that rule. No new trust path.
- `finishTurn` (`:2757-2809`) persists and schedules the next check
  (`kickWake`, `:2807`) outside the steering window. A fire that lost the slot
  is retried there, as the exit wake is.

T-D1 (S3) proves it end to end over the real `SessionHost` + `Connection`, on
an injected clock, before anything else.

### Preconditions (verified)

- **P1 — where a tool reaches session state.** Tools are built by the CLI
  factory (`packages/cli/src/wiring.ts`) inside `createAgent`, BEFORE the
  `HostedSession` exists (`session-host.ts:1341-1372`). The established seam is a
  LAZY link in `AgentContext` (`session-host.ts:98`): `modelLink: () =>
  bound.hosted?.modelLink() ?? null` (`:1361`). A schedule link is the same:
  `schedules: () => bound.hosted?.scheduleLink() ?? null`. On a settings sync
  the agent is rebuilt (`updateSettings`, `:1431-1478`); the table lives on the
  `HostedSession`, not the agent, so it survives. The new factory call must be
  passed the same link (`:1438`).
- **P2 — runtime gating has a precedent.** `workload_shell` is offered only when
  the caller passes a backend: "the local worker and `serve`; never a pod daemon"
  (`wiring.ts:673-686`). `move_session` is offered only when a host option says
  so (`:665-672`). Host builders: `serve` `SessionHost` (`serve.ts:723`), pod
  `podSessionHost` (`serve.ts:1236`, `pod-resident.ts:803`), worker
  `workerSessionHost` (`packages/cli/src/worker.ts:83`).
- **P3 — tool shape conventions.** Names are snake_case with a domain prefix
  (`shell_output`, `agent_control`; `docs/feat/tool-naming.md`: names in code
  unchanged, CamelCase only as display labels via `toolLabel`).
  `agent_control` (`packages/tools/src/agent-control.ts:1-18`) is the pattern
  for "one tool, several actions": a flat object, no `oneOf` (local models handle
  it poorly), the action's required fields checked in `execute`. `permission` is
  STATIC per tool: `PermissionLevel = "none" | "ask" | "deny"`
  (`packages/core/src/tool.ts:15`, `:173`). So "create asks, list/delete don't"
  needs two tools.
- **P4 — a child never gets parent-only tools.** The sub-agent filter
  (`packages/agent/src/subagent.ts:376-390`) drops `agent_control`,
  `context_reset`, `move_session`. The new tools join that list.
- **P5 — an ask with nobody attached is HELD** (durably, past the cut; the
  turn holds the slot until a client answers; restart re-asks it).
  `docs/feat/serve-autowake.md` P4, unchanged since. A fired turn obeys it.
- **P6 — the list-on-the-wire pattern exists.** `jobs` update = the full list,
  sent on change only (`packages/protocol/src/updates.ts:364-367`, class
  `display` `:505`). `JobRowSchema` (`session.ts:656-670`), the first page of
  `OpenResult` carries `jobs` (`:755-756`), `SessionListEntry.jobs` is a count
  (`:1300-1301`), and the user's handle is the method `session/job_kill`.
  The reverse mapping goes in `client/mapping.ts` (`auto_accept` at `:353` is
  the latest example).
- **P7 — sidecar fields and versions.** `DaemonSidecar`
  (`packages/daemon/src/daemon-state-file.ts:68-97`). Two precedents for a new
  field. `autoAccept` is written only when on, no version bump; an older build
  drops it, which fails closed (`:90-96`, `:129`). Image refs stamp
  `DAEMON_STATE_VERSION = 2` only when present, so an older build REFUSES that
  one session loudly instead of half-loading it (`:47-65`, `:115`).
- **P8 — session-log criticality is an owner table.** `protocol/src/session-log.ts:12-17`:
  critical = `base`, `message`, `replace`, `truncate`; everything else skippable.
  Adding a critical type is an owner decision.
- **P9 — idle TTL.** Detached + not busy for `DEFAULT_SESSION_TTL_MS` = 24 h
  (`session-reaper.ts:19`) → closed (archived on `serve`). `liveness().busy`
  counts the turn and running background sub-agents, NOT shell jobs
  (`hosted-session.ts:1652-1662`).
- **P10 — `/clear` resets in place.** `HostedSession.clear()` (`:3104`) keeps jobs
  and children (`docs/feat/clear-keeps-jobs.md`) but clears the session approvals
  (`:3131-3133`); the dropped chat becomes a fork built from messages only.
- **P11 — the worker is laptop code.** Since `feat/session-auto-accept` the
  worker call site already sets a trust bit (`sharedAutoAccept: true`,
  `packages/cli/src/local-runtime.ts:1483`). `daemonWakes` is set only by
  `connect` today.

### Design

#### D1 — Where the timer lives, per runtime

| Runtime | Offered? | Timer | Persisted | Fires with nobody attached |
|---|---|---|---|---|
| `serve` (trusted, user's host) | yes | `HostedSession` | sidecar (D6) | yes — that is the point |
| local worker (laptop thread) | yes | the worker's `HostedSession` | no: lives as long as the TUI | n/a (TUI is there; ends at quit) |
| `connect` → `serve` | via `serve` | the `serve` daemon | `serve`'s sidecar | yes |
| phone → `serve` | via `serve` | same | same | yes |
| pod `run` / `attach` | **no** (v1) | — | — | — |
| detached run (pod relay) | **no** (v1) | — | — | — |

One implementation: the timer is in `HostedSession`, switched on by a new
`SessionHostOptions.schedules` (config limits) passed by `serve` and the worker
only. A pod daemon's `podSessionHost` never passes it → no link → the factory
never offers the tools (P2 pattern). In a pod the tool runs IN the pod, so a
pod-side timer would mean a pod deciding when turns start on the laptop's
model key. A laptop-owned timer fed by a pod-published list would be a second
turn driver plus a laptop-side gate on pod-supplied prompts. Both are real
designs; neither is needed for v1 (Owner Q4). The table and the tool are
runtime-neutral, so adding pods later is a new host option plus that gate,
not a rewrite.

Worker: its fired turns are `wake-` turns minted by laptop code. The worker
call site sets `daemonWakes: true` (next to `sharedAutoAccept`, P11), so the
local TUI's auto-accept treats them as the session's own
(`autoAcceptsTurn`, `docs/fix/autoaccept-wake-turns.md` A4). Pods and the relay
never set it (unchanged). **Corrected by S4's executor (verified, 2026-11-16):**
the bit alone is not enough. The worker TUI's controller (`persistingController`,
`local-runtime.ts`) forwarded `ownsTurn` but not `autoAcceptsTurn`, so the TUI
fell back to `ownsTurn` and a `wake-` turn stayed foreign. S4 forwards it too.

#### D2 — Tool shape (model-facing)

Two tools (P3: permission is static):

**`schedule_create`** — `permission: "ask"`. Flat input:

| field | type | meaning |
|---|---|---|
| `prompt` | string, 1–2000 | what you will be told when it fires; must be self-sufficient (the context may be compacted by then) |
| `every` | string, optional | recurring interval: `90s` is refused, `1m`…`7d` (`m`/`h`/`d`) |
| `at` | string, optional | one-shot: ISO 8601 (`2026-11-16T17:00`, local time of the daemon host, or with offset) or relative `in 20m` |
| `cron` | string, optional | **only if Owner Q2 = include**: 5-field expression, daemon host's local time zone |

Exactly one of `every`/`at`/`cron`, checked in `execute` with a repair sentence
(the `agent_control` rule). Result text (the model reads it):
`Scheduled sc-3: every 10m, next at 14:30 (in 10m), expires 2026-11-22 14:20. When it fires you get: "[scheduled sc-3 · every 10m] <prompt>". It lasts while this session runs (local: until the user quits).`

**`schedule_control`** — `permission: "none"`, `{ action: "list" | "delete", id? }`
(the `agent_control` shape, read-class concurrency for `list`). `list` →
one line per job: `sc-3 · every 10m · next 14:30 · fired 4× · "check CI…"`.
`delete` (id) → `Deleted sc-3.` / `No schedule sc-3 (see list).`

Ids: `sc-N`, per session, monotonic, never reused in a session (like `bg-N`,
`sa-N`). Display labels: `Schedule`, `Schedules` (`toolLabel` map). Both tools
go in the child filter (P4). Descriptions are short; each costs tokens on every
request.

Why not one tool `schedule{action}`: `list` would then ask. Why not three:
one more definition per request for no gain.

#### D3 — Fire semantics (pure: `packages/core/src/schedule.ts`)

State per job: `{ id, kind: "every"|"at"|"cron", spec, prompt, createdAt,
expiresAt, nextAt, fires, failures, createdBy: turnId }`. All times are
epoch ms from the host's injected `now()` (`session-host.ts:1327`).

- **Ticking:** `HostedSession` arms ONE `setTimeout` to `min(nextAt_min - now, 60 s)`.
  It is re-armed at every check, so a sleep, a clock jump or a long delay is
  noticed within 60 s, and the timer never meets the 2³¹-ms `setTimeout` limit.
  Each check calls the pure `scheduleStep(table, now, { idle })` → `{ due: Job |
  null, table' }`. The `idle` flag is REQUIRED (`ScheduleStepOptions`, round 1):
  a busy check sweeps expiry but fires nothing and loses no slot, and
  `scheduleCheckDelayMs(table, now, { idle: false })` answers a full check
  interval instead of 0, so a turn holding the slot cannot spin `setTimeout(0)`.
- **Only when idle:** the gate reuses `wakeDue({pending: due !== null}, {enabled,
  idle: !running, blocked: closed || archived})` (`auto-wake.ts:35`). A fire
  does NOT honour `lastEndBad`: a user's Esc on some turn must not silence a
  reminder. Fires are bounded by the per-job failure rule below instead.
- **Busy → coalesce:** a due job stays due (one pending fire per job, never a
  queue of fires). It is re-checked by `kickWake`, which already runs at every
  turn end and compaction end (`:2807`, `:3093`). Two jobs due together → the
  older `nextAt` fires; the other fires at the next idle check (one turn each,
  never merged prompts: each turn shows exactly what fired it).
- **Advance BEFORE firing (at-most-once):** in the same synchronous stretch:
  `nextAt` = next slot strictly after `now` (missed slots are skipped, not
  replayed), `fires++`, `persist()` (synchronous capture), then `prompt()`. A
  crash mid-turn never re-fires that slot. The cut turn is closed honestly by
  the existing reload rule.
- **Missed fires (daemon down, Mac asleep, session busy for hours):** **catch-up
  ONCE** — an overdue job fires once on the first idle check, then resumes its
  schedule from now (anacron behaviour). A one-shot overdue at reload fires
  once if not past `expiresAt`.
- **Clock backwards:** for `every`, if `nextAt - now > interval`, clamp to `now
  + interval` (pure rule, tested). Forward jump = an ordinary catch-up.
- **Time zone:** the daemon host's local zone for `at` without an offset and for
  `cron`; rows carry epoch ms, so each client renders in its own zone. On
  `serve` the daemon is the user's own machine, so the two zones match in practice.
- **Jitter:** none. One user, few jobs; exact times are easier to trust and to test.
- **Limits** (config `schedules.*`, read from the HOST's own config like
  `autoWake`, `serve-autowake.md` D5; defaults → Owner Q6): min interval 1 m;
  max 10 live jobs per session; recurring jobs expire 7 days after creation
  (Claude Code's rule), with a one-line notice when they do; `at` at most 7 days
  ahead; prompt ≤ 2000 chars. A refusal is a tool error the model reads, never
  a silent clamp.
- **Wake-loop guard:** a fired turn MAY create schedules. That is required so a
  one-shot can re-arm itself (`ScheduleWakeup`-style self-pacing). The loop is
  bounded by the caps: ≤ 10 jobs × ≥ 1 m. Every create asks (D4); with nobody
  attached the ask is held, so an unattended loop needs the user's own "always"
  or auto-accept. A per-job **failure stop**: a fire turn that ends `error` →
  `failures++`; 3 in a row → the job is removed with a notice. A normal end
  resets the count, and `cancelled` (user Esc) does not count. So a dead model
  key costs 3 failed turns, not one per interval forever.
- **The prompt the model sees:** the user message text is
  `[scheduled sc-3 · every 10m · fire 4] <prompt>`. That text is the durable
  truth: it is persisted with the conversation, it survives reload, and the
  model can tell the message is not a live one from the user.

#### D4 — Permission

- `schedule_create` asks through the session's single broker like any `ask`
  tool. The prompt reads `Schedule a wake every 10m: "check CI and report"`.
  Scopes are the normal ones; an "always" on a trusted runtime (`serve`/worker)
  lets the model re-arm without asking. No new broker, requester or rule store
  (§7 single broker).
- A fired turn runs under the session's normal policy. Its asks are held with
  nobody attached (P5), so the session stays busy and later fires coalesce
  (bounded). `connect`/phone/worker auto-accept answers them as the session's
  own (`wake-` id, D1).
- Pods: the tool is not offered (D1), so there is no pod-originated approval to
  limit.

#### D5 — Protocol (all additive — **no `protocol.d/` note, no `PROTOCOL_VERSION` bump**)

- `ScheduleRowSchema` (`session.ts`, beside `JobRowSchema`): `{ id, kind,
  spec (the text as given, e.g. "every 10m"), prompt (cut by the daemon to 200,
  a label), nextAt, expiresAt?, fires, createdAt }`, lenient like `JobRow`.
- Update `{ type: "schedules", schedules: ScheduleRow[] }` — the FULL list on
  every change (create, delete, fire, expiry, failure stop). Class **display**
  (`UPDATE_CLASS`): nothing waits on it, and an older client shows
  `unsupported` once and loses nothing. Reverse mapping in `client/mapping.ts`.
- `OpenResult.schedules?` (first page, like `jobs`) and
  `SessionListEntry.schedules?: number` (count, for `/sessions` and the phone list).
  **Corrected by S2's executor (verified against the code, 2026-11-16):** the
  first page that carries `jobs` is **`SnapshotResult`**, not `OpenResult`
  (`packages/protocol/src/session.ts:755` `jobs`, `:938` `OpenResultSchema`). The
  list rides `SnapshotResult.schedules` — the same fold a resync already applies
  to `jobs` — and `SessionListEntry.schedules` stays the count.
- Method `session/schedule_delete { sessionId, scheduleId } → { deleted: boolean }`.
  Synchronous daemon-side, never awaits a turn (§7: don't serialize the peer).
  An older daemon answers `MethodNotFound`, shown as a notice. There is no
  user-side create in v1 (the user asks the agent).
- `TurnStartSchema.schedule?: { id, spec }` — optional display data so a client
  can style a fired turn (UI option B, D8). A strip schema means an older
  client drops it.
- Client trust: a client shows `schedules` and offers delete only when
  `daemonWakes` is on (connect, worker after D1, phone). That is the existing
  "this daemon starts its own turns" bit; a pod's frames are dropped. No new bit.

#### D6 — Persistence

- **Not a session-log entry.** A schedule is session STATE, not conversation
  (§7: "Persist only the conversation"). The conversation already records the
  `schedule_create` call/result and each fired prompt as ordinary messages.
  So no new log type, and no critical-table question. (A log type `schedule`
  is the alternative; if wanted, its criticality is the owner's call: Owner Q8.)
- **`serve`:** `DaemonSidecar.schedules?: ScheduleRecord[]`, written only when
  non-empty. Recommended: stamp `DAEMON_STATE_VERSION = 3` exactly when present
  (the media precedent, P7). An older build then refuses that one session
  loudly and leaves its files untouched, instead of dropping the jobs and
  rewriting the sidecar without them (the `autoAccept` precedent drops silently;
  that is fine for a fail-closed flag, but here it loses user data). Sessions
  without schedules stay readable by every build. **The version mechanics need
  an executor check:** `DAEMON_STATE_VERSIONS` becomes `[1, 2, 3]`; v3 may
  also carry media. Reload: re-arm, catch-up once (D3).
- **Archived** (`session/close`, TTL, cap): the table stays in the sidecar,
  frozen. Nothing fires while archived. An explicit `session/open{reopen}`
  re-arms what has not expired (catch-up once). `session/delete` deletes it
  with the files.
- **Worker:** memory only (pods and the worker never persist, §7). `--resume` of
  a local session starts with no schedules. The quit confirmation names them
  (UI M6).

#### D7 — Lifecycle interactions

| Event | Schedules |
|---|---|
| compaction / `context_reset` | kept (outside the history; the prompt is self-sufficient by contract) |
| `/clear` (in place) | **kept** (Owner Q7 answer, "tienili"): like background jobs, they stay with the session that goes on; no notice. (The original "drop" rule was overruled; updated by S3's executor.) |
| `/clear` fork (the kept old chat) | none: the fork is built from messages only |
| settings sync (agent rebuilt) | kept (table on `HostedSession`; the link is passed to the new factory call, P1) |
| session hop (`move_session`) | not carried in v1; the hop's summary notice says `N scheduled wakes dropped` |
| idle TTL on `serve` | an armed schedule counts as **not idle** (Owner Q5): a daily reminder must not be archived after 24 h of silence. Bounded by the 7-day expiry. `adminCapMs` still applies |
| close / delete | `close` clears the timer (like `wakeKick`, `:3248`); delete removes the record |

#### D8 — User surfaces (mockups; style choices wait for the owner, Owner Q9)

**M1 — the create ask (terminal)**
```
╭─ Schedule ─────────────────────────────────────────────────────────╮
│ Schedule a wake every 10m (next 14:30, expires 22 Nov 14:20):      │
│   "check CI on PR #412; if green, say so and stop the schedule"    │
│                                                                    │
│ › Yes   Yes, and don't ask again this session   No, tell it why    │
╰────────────────────────────────────────────────────────────────────╯
```

**M2 — the dock: pill + dropdown rows (reuses the background dropdown grammar, `docs/feat/shell-jobs-panel.md`)**
```
~/tentacle · ctx 41k/200k            ⏵⏵ auto-accept off  ·  1 agent · 2 sched ▴

─ background · 3 ───────────────────────────── enter open · x delete · esc back ─
  ● sa-1  Ada: review the diff                      6 tools · 22k · 2m 10s
› ◷ sc-1  check CI on PR #412                       every 10m · next 14:30 · 4×
  ◷ sc-2  remind: standup notes                     at 17:00 today · in 2h 29m
```

**M3 — `/schedule` (alias `/schedules`): a panel like `/skills`, `/mcp`**
```
─ scheduled wakes · 2 ───────────────────────────── x delete · esc close ─
› sc-1  every 10m   next 14:30 (in 9m)   fired 4×   expires 22 Nov
        "check CI on PR #412; if green, say so and stop the schedule"
  sc-2  at 17:00    in 2h 29m            one-shot
        "remind: standup notes — open docs/standup.md and summarize"
  (local session: these end when you quit)
```

**M4 — a fired turn in the transcript.** Option A (plain, no protocol field) vs
option B (styled from `turn_start.schedule`):
```
A │ > [scheduled sc-1 · every 10m · fire 5] check CI on PR #412; if green…
  │ ● CI is still running (3/7 jobs). I'll look again at the next wake.

B │ ◷ scheduled · sc-1 every 10m · fire 5
  │   check CI on PR #412; if green, say so and stop the schedule
  │ ● CI is still running (3/7 jobs). I'll look again at the next wake.
```
On reload B degrades to A (the text prefix is the durable truth, D3).

**M5 — tool results in the transcript**
```
● Schedule  every 10m · "check CI on PR #412…"
  ⎿ Scheduled sc-1: next 14:30 (in 10m), expires 22 Nov 14:20
● Schedules  delete sc-1
  ⎿ Deleted sc-1.
```

**M6 — local quit with armed schedules (worker only)**
```
Quit? 2 scheduled wakes (sc-1, sc-2) end with this session.   y quit · n stay
```

**M7 — iPhone, Session info sheet: a new section** (pure view-model in
`apps/mobile/src/session-info.ts`, per its per-section `Pull` states)
```
┌──────────────────────────────────────┐
│ Session info                    Done │
│ ● Idle · qwen3-27b                   │
│ …                                    │
│ SCHEDULED WAKES                      │
│ ◷ check CI on PR #412           ›    │
│   every 10m · next 14:30 · 4×        │
│ ◷ remind: standup notes         ›    │
│   today 17:00 · one-shot             │
│              (swipe left: Delete)    │
└──────────────────────────────────────┘
```
**M8 — iPhone chat: a fired turn** (option B; option A shows the raw prefix in
the user bubble)
```
            ┌───────────────────────────────┐
            │ ◷ Scheduled · every 10m       │
            │ check CI on PR #412; if green…│
            └───────────────────────────────┘
 ● CI is still running (3/7 jobs). I'll look
   again at the next wake.
```
The session list row shows `◷ 2` beside the existing jobs count
(`SessionListEntry.schedules`). An older daemon: the section reads
`Not supported by this computer's tentacle` (the sheet's existing `unsupported` state).

### Slices (dependency order; one branch, merged as a whole)

| # | Slice | Size | Blast | Notes |
|---|---|---|---|---|
| S1 | `core/src/schedule.ts`: parse `every`/`at`, `scheduleStep`, next-slot, catch-up once, back-jump clamp, caps, expiry, failure stop; row shape | S | contained | pure, no timers |
| S1b | `cron` 5-field parser + next-match (only if Owner Q2 = include) | S | contained | pure |
| S2 | protocol: `ScheduleRowSchema`, `schedules` update + `UPDATE_CLASS` display, **`SnapshotResult.schedules`** (see the D5 correction), `SessionListEntry.schedules`, `session/schedule_delete`, `TurnStart.schedule`; `client/mapping.ts` reverse; `protocol.json` regen | S | cross-module | additive, no note |
| S3 | daemon: `HostedSession` table + timer + fire (`wake-` id, advance→persist→prompt) + gate via `wakeDue` + `scheduleLink()` + liveness + clear/close/archive/reopen; `SessionHostOptions.schedules`; `AgentContext.schedules` in `build` AND `updateSettings`; sidecar v3 + reload | M | load-bearing | strong executor |
| S4 | tools + wiring: `schedule_create`/`schedule_control`, child filter, labels, config `schedules.*`; `serve` + worker pass the option; worker `daemonWakes: true` | M | load-bearing | trust bit + permission |
| S5 | TUI: pure `schedule-view.ts` (rows, pill text, panel, fired-row model) + dock rows, `/schedule` panel, delete via the method, M4/M6 | M | contained | waits for the owner's mockup choice |
| S6 | mobile: Session info section + delete, list badge, fired bubble | M | contained | waits for the owner's mockup choice |

### Files (dependency order)

1. `packages/core/src/schedule.ts` (new), `core/src/index.ts` export; `core/test/schedule.test.ts`.
2. `packages/protocol/src/session.ts`, `updates.ts`, `methods`/registry file
   where `session/job_kill` is declared, `schema/protocol.json` (regenerated);
   `packages/client/src/mapping.ts`, `remote-client.ts`/`remote-session.ts`
   (`schedules` feed + `deleteSchedule`, gated on `daemonWakes`).
3. `packages/daemon/src/hosted-session.ts`, `session-host.ts`,
   `daemon-state-file.ts`, `persisted-session.ts`, `connection.ts`
   (`schedule_delete` handler), `session-list.ts` (count).
4. `packages/tools/src/schedule.ts` (new), `tools/src/index.ts`,
   `core/src/tool-labels.ts`, `packages/agent/src/subagent.ts` (filter),
   `packages/config` (`schedules.*` schema/defaults/resolve),
   `packages/cli/src/wiring.ts`, `serve.ts`, `worker.ts`, `local-runtime.ts`
   (`daemonWakes` at the worker call site).
5. `packages/tui/src/schedule-view.ts` (new), `commands/schedule.ts` (new),
   `panels/`, `background-list.ts`/dock, `AppView.tsx`, quit confirm.
6. `apps/mobile/src/session-info.ts`, its sheet component, chat bubble, list row.
7. Docs: `docs/attach-detach-behaviour.md` row, README config keys,
   `changelog.d/cron-tool.added.md`, `TODO.md` at merge.

### Failure modes

| Case | Outcome | Convergence |
|---|---|---|
| fire while a turn/compaction runs | job stays due (one pending fire) | fires at the turn/compaction end (`kickWake`) |
| fire + client prompt race | `assertIdle` picks one; a fire that lost re-checks at the turn end; a client that lost gets `TurnInProgress` → its TUI enqueues (steers the fired turn) | one turn at a time |
| fire + job-exit wake due together | one turn: the fire's start flushes the exits | exit count 0 |
| fired turn asks, nobody attached | held, durable, slot busy, later fires coalesce | a client answers / cancels; restart re-asks |
| daemon crash mid-fire | slot already advanced + persisted before `prompt` | no re-fire; cut turn closed honestly |
| daemon down / Mac asleep across N slots | one catch-up fire at the first idle check (≤ 60 s after resume) | schedule resumes from now |
| wall clock jumps back | `every` clamped to `now + interval` | no indefinite stall |
| model key dead (401) | 3 failed fires → job removed + notice | no cost loop |
| model creates schedules from fired turns | caps (10 jobs, ≥ 1 m), each create asks | bounded rate |
| 11th create / interval < 1 m / `at` in the past or > 7 d / two kinds given | tool error with the reason | model repairs |
| recurring job passes 7 days | removed + notice + `schedules` update | — |
| session archived (close/TTL/cap) | frozen in the sidecar, no fire | `reopen` re-arms, catch-up once |
| session deleted | removed with the files | — |
| older build reads a v3 sidecar | refuses that session loudly, files untouched | upgrade |
| older client | `schedules` shown once as `unsupported`; `turn_start.schedule` dropped; prefix text still shows | — |
| older daemon | no tools (none offered), `schedule_delete` → `MethodNotFound` notice | — |
| pod daemon claims schedules (`schedules` frame) | dropped by the laptop (`daemonWakes` off) | — |
| forged `session/prompt{turnId:"wake-…"}` | refused already (`connection.ts:1037`) | — |
| settings sync during an armed timer | table + timer on `HostedSession`, untouched | — |
| `/clear` | kept (Q7 answer); the archived fork carries none | only the live session owns the table: no duplicate firing |
| worker quit | schedules end; M6 warns | — |

### Tests (red first, §9; existing fakes only)

- **Core (S1/S1b)** `core/test/schedule.test.ts`: parse table (accept/refuse
  with reasons); `scheduleStep` on an injected `now`: due/not due, catch-up ONCE
  after N missed slots (mutation: replay every slot → red), back-jump clamp
  (mutation: drop clamp → red), expiry, one-shot removed after fire,
  failure stop at 3 (mutation: never count → red), cancel not counted, cap 10.
- **Daemon (S3)** `daemon/test/schedules.test.ts`, the `serve-autowake.test.ts`
  rig (real `SessionHost` + `Connection`, scripted model, injected clock, the
  check called directly; no real sleeps):
  - **T-D1 (red on main)**: create via the link, advance the clock past
    `nextAt`, check → a `wake-` turn whose prompt starts `[scheduled sc-1`,
    the model saw it. *Mutation:* skip the fire → red.
  - T-D2 busy: due while a turn runs → no second turn; at its end exactly one fire.
  - T-D3 advance-before-fire: snapshot the persisted record at `turn_start` → `nextAt` already moved.
  - T-D4 reload: persister rig → restart past two slots → exactly one catch-up fire; v3 stamped only when non-empty; v1/v2 files still load.
  - T-D5 held ask with nobody attached → busy, no further fire; attach + resolve → completes.
  - T-D6 `/clear` KEEPS the table (Q7 answer) and the fork carries none; compaction keeps; settings sync keeps (mutation: table on the agent → red).
  - T-D7 archive freezes, `reopen` re-arms; close clears the timer (mutation: don't clear → a fire after close → red).
  - T-D8 liveness: an armed schedule keeps a detached session out of `reapExpired` (if Q5 = yes).
  - T-D9 `schedule_delete` over the wire; `schedules` update after each change; synchronous handler.
  - T-D10 pod host (`podSessionHost`) → no link, tools absent.
- **Tools (S4)** `tools/test/schedule.test.ts`: exactly-one-kind repair texts,
  result text, `list`/`delete`; child filter excludes both (mutation: remove from
  filter → red); `wiring` offers them only with the link.
- **Client/CLI (S4)**: worker call site sets `daemonWakes` (wiring test); a
  `connect`/worker TUI auto-accepts a fired turn's ask, a pod runtime does not;
  a pod's `schedules` frame is dropped.
- **TUI (S5)** pure `schedule-view` tests + one `ink-testing-library` frame per
  mockup chosen (dock rows, panel, fired row, quit warning).
- **Mobile (S6)** pure view-model tests for the section (ready / empty /
  unsupported / error), the list badge, the fired bubble.

Gate before done: `bun run check` (typecheck → lint, baseline clean → test; only the three opt-in skips).

### Owner questions

1. **Tool shape.** Two tools, `schedule_create` (ask) + `schedule_control
   {list|delete}` (none), ids `sc-N`. **Rec: yes** (P3: permission is static;
   `agent_control` pattern).
2. **Kinds in v1.** `every` + `at` only, or also 5-field `cron` (slice S1b)?
   **Rec: `every` + `at` now, `cron` as a follow-up.** Local models write
   `every: 10m` far more reliably than cron syntax, and S1b stays isolated.
3. **Create permission.** `ask` (normal scopes; "always" allowed on
   `serve`/worker) vs `none` (Claude Code does not ask). **Rec: `ask`**: an
   unattended schedule spends the user's model budget, so consent should be visible.
4. **Runtimes.** `serve` + local worker (session-lifetime, lost on quit) now;
   pod `run`/`attach`/detached runs excluded. **Rec: yes**; pods later as their
   own task with a laptop-side gate (D1).
5. **Idle TTL.** Does an armed schedule keep a detached `serve` session live
   (not archived after 24 h), bounded by the 7-day expiry? **Rec: yes**,
   otherwise a daily reminder silently dies.
6. **Limits.** min interval 1 m, ≤ 10 jobs/session, recurring expire after
   7 d, `at` ≤ 7 d ahead, prompt ≤ 2000 chars, all as `schedules.*` config on
   the host. **Rec: these defaults.**
7. **`/clear`.** Drop the schedules (with a notice) or keep them like
   background jobs? **Rec: drop**: they belong to the cleared chat, as the
   approvals do.
8. **Persistence.** In the `serve` sidecar, stamped `DAEMON_STATE_VERSION = 3`
   only when present (an older build refuses loudly), NOT a session-log entry
   type, so no `critical: true` decision is needed. **Rec: yes.** The
   alternatives are an optional field with no bump (the `autoAccept`
   precedent: an older build drops the jobs silently), or a new log type whose
   criticality you would have to set.
9. **UI style.** Fired turn as option B (styled row from `turn_start.schedule`)
   vs A (plain prefix); dock rows `◷ sc-N` + pill `N sched`; `/schedule`
   panel; iPhone Session-info section + fired bubble; local quit warning.
   **Rec: B + all of M2/M3/M6/M7/M8.** S5/S6 start only after your choice
   on the mockups.


#### Owner answers (2026-11-16 ~00:15, binding)

*— recorded by claude-opus-5-5 (orchestrator), 2026-11-16*

- **Q1 yes** — `schedule_create` (ask) + `schedule_control {list|delete}` (none), ids `sc-N`.
- **Q2 `every` + `at` only.** Slice **S1b is dropped** (5-field `cron` is a later follow-up).
- **Q3 yes** — creating asks (normal scopes; "always" allowed on `serve`/worker).
- **Q4 yes** — `serve` + local worker only; pods excluded in v1.
- **Q5 yes** — an armed schedule keeps a detached `serve` session live past the 24 h idle TTL, bounded by the 7-day expiry.
- **Q6 yes** — min 1 m, ≤ 10 jobs/session, 7 d expiry, `at` ≤ 7 d, prompt ≤ 2000 chars, `schedules.*` config.
- **Q7 CHANGED: KEEP them on `/clear`** ("tienili"), like background jobs: the schedules stay with the session that continues after `/clear`; the archived fork (the dropped chat) carries NONE (no duplicate firing). The `/clear` notice is not needed. **Executor of S3: update D-sections, failure modes and tests that assumed "drop" (search `/clear`) to this rule before coding.**
- **Q8 yes** — `serve` sidecar, `DAEMON_STATE_VERSION = 3` only when present; no session-log entry type.
- **Q9 B** — styled fired row from `turn_start.schedule` (degrades to A on reload), plus M2 dock rows/pill, M3 `/schedule` panel, M6 local quit warning, M7 iPhone Session-info section, M8 fired bubble. S5/S6 are unblocked.

**Merge plan:** one branch, slices S1 → S2 → S3 → S4 → S5 → S6 each executed + reviewed on it; merged to `main` once, after S6 PASS.

## Execution

### S1 — `core/src/schedule.ts` (pure table)

*— claude-opus-5-5, 2026-11-16*

**Scope: S1 only** (S1b dropped by Owner Q2).

**Repro re-run first** (feature missing, on this branch @ `a5afc1aa`):
`rg -n -i "cron|schedul" packages/tools/src packages/protocol/src/updates.ts
packages/daemon/src/hosted-session.ts packages/daemon/src/daemon-state-file.ts`
→ only the word "schedule" used for macrotasks/the persister (9 hits, same list as
Context); `packages/core/src/schedule.ts` and `core/test/schedule.test.ts` do not
exist; `core/src/index.ts` exports nothing schedule-related. **Load-bearing
assumption re-checked** (`prompt()`/`assertIdle` at `hosted-session.ts:2262`,
`:2621`; `WAKE_TURN_PREFIX`/`isWakeTurnId` at `protocol/src/session.ts:311-315`;
`refuseWakeTurnId` at `daemon/src/connection.ts:1036`; host clock
`SessionHostOptions.now` at `session-host.ts:231`) — all hold as cited, and the
daemon's own wake already calls `prompt()` directly with no request (`:2858`). No
contradiction found; S1 needed none of it (it is pure), so nothing was blocked.

**Red first.** `packages/core/test/schedule.test.ts` written before the module:
`bun test packages/core/test/schedule.test.ts` → `Cannot find module
'../src/schedule.ts'`, 0 pass / 1 fail. Then the module, then green (31 pass).

**As built** — `packages/core/src/schedule.ts` (new, exported from
`core/src/index.ts`):
- `ScheduledJob` row: `{ id, kind: "every"|"at", spec, intervalMs?, prompt,
  createdAt, expiresAt, nextAt, fires, failures, createdBy }`.
- `parseDurationMs` (`m`/`h`/`d` only — `90s` refused), `parseScheduleSpec`
  (exactly one of `every`/`at`, 1 m…7 d interval, `at` = bare date / local
  date-time / offset / `in 20m`, past and >7 d refused with a reason),
  `scheduleCreate` (id minted by the caller, prompt 1…2000 chars, cap 10,
  table replaced never mutated), `scheduleStep` (advance-BEFORE-fire,
  catch-up ONCE, one pending fire, back-jump clamp, expiry sweep, older
  `nextAt` wins), `scheduleSettled` (error ×3 → removed; `ok` resets;
  `cancelled` ignored), `scheduleDelete`, `schedulePromptText`
  (`[scheduled sc-1 · every 10m · fire 1] …`), `nextDueAt` and
  `scheduleCheckDelayMs` (the daemon's one `setTimeout`: ≤ 60 s, ≥ 0).

**Drift from Implementation (all deliberate):**
1. **`at` needs a grace window to have the plan's reload rule.** D6 says "a
   one-shot overdue at reload fires once if not past `expiresAt`", but D3 never
   said what `expiresAt` is for an `at` job. Fixed to `nextAt +
   SCHEDULE_TTL_MS` (7 d), so a host that was asleep past the time still fires
   it ONCE and a one genuinely abandoned is removed instead of firing days
   late. S3 relies on this; the D3 state list is otherwise unchanged.
2. **`intervalMs` added to the row.** The plan's state list carries `spec`
   (display text) only; the pure `slotAfter`/clamp arithmetic needs the
   interval as a number, and re-parsing display text would be a second rule.
   The wire row (S2, D5) is unaffected: it carries `spec`, not `intervalMs`.
3. **A relative `at` is stored resolved.** `at: "in 20m"` becomes `spec: "at
   2026-11-16T10:20"` (host zone) — a row read five minutes later must not
   still say "in 20m". Not in the plan; the alternative is a lie in every UI.
4. **`scheduleFiredMessage` removed.** It only wrapped `{role, content}`, and
   S3 calls `prompt()` with content blocks, not `ChatMessage`s — dead code, so
   it is not shipped.
5. **Failure stop is `scheduleSettled(table, id, end)`,** keyed by the job's id
   (the daemon knows which job a `wake-` turn fired). The plan described the
   rule but not the seam; S3 calls this one function on a fired turn's end.

**Mutation checks** (each applied to the module, the named test re-run, then
`cp` from `.tentacle/tmp/cron-tool/schedule.ts.bak` restored — verified
byte-identical with `diff -q`):
| # | Mutation | Red |
|---|---|---|
| M1 | drop catch-up-once (re-arm from the old slot) | 3 fail: `catch-up ONCE…`, `two due together…`, `a forward jump…` |
| M2 | drop the back-jump clamp | 1 fail: `the clock jumped backwards…` |
| M3 | never count failures (`if (false)`) | 1 fail: `three errors in a row remove the job` |
| M4 | drop the expiry arm | 2 fail: `recurring job past its 7-day expiry…`, `one-shot past its grace…` |
| M5 | count a `cancelled` end | 1 fail: `a cancelled turn does not count (nor reset)` |
| M6 | drop the 10-job cap | 1 fail: `the 11th live job is refused…` |
| M7 | keep a one-shot after it fires | 2 fail: `a one-shot fires once and leaves the table`, `…overdue while we were down…` |
| M8 | fire without advancing (`fires`/`nextAt` unchanged) | 6 fail incl. `at-most-once` and `the prefix names the job…` |

**Gate**: `bunx tsc --noEmit` → 0; `bun run lint` (`biome check .`, 1660 files)
→ clean, no fixes; `bun test` → **12008 pass, 5 skip, 0 fail** (858 files,
443 s). The 5 skips were enumerated one file at a time, all pre-existing
opt-ins: `k8s/test/integration.live` + `cli/test/workload-shell-live.k8s`
(`TENTACLE_K8S_SERVER`), `docker/test/integration.live` +
`cli/test/session-hop.docker` (`TENTACLE_DOCKER_TESTS=1`),
`daemon/test/ws-server` (`TENTACLE_SLOW_TESTS=1`) — i.e. AGENTS §6's three
opt-ins across five files; **no new skip, and none in `core`**.
No schema change, so `packages/protocol/schema/protocol.json` is untouched; no
`protocol.d/` note (S1 is pure core). Changelog:
`changelog.d/cron-tool.added.md` (one bullet; `CHANGELOG.md` untouched).

**S1: DONE.** S2–S6 not started (per the slice instruction).

### S2 — protocol + client (scheduled wakes on the wire)

*— deepseek-v4.1-flash (tentacle), 2026-11-16*

**Scope: S2 only** (S1 is done above; S3–S6 untouched).

**Load-bearing check re-run first** (this branch @ `6882b4d5`), before any edit:
- **Repro (feature missing).** `rg -n -i "cron|schedul" packages/tools/src
  packages/protocol/src/updates.ts packages/daemon/src/hosted-session.ts
  packages/daemon/src/daemon-state-file.ts` → the same 7 hits as Context, all the
  word "schedule" for macrotasks/the persister. `rg -n "ScheduleRow|schedule_delete|schedules"
  packages/protocol/src packages/client/src` → **no hits** (exit 1): no row, no
  update, no method, no client feed.
- **The anchors the plan's assumption rests on, re-verified by reading:**
  `HostedSession.prompt` `packages/daemon/src/hosted-session.ts:2262`,
  `assertIdle` `:2621`; `WAKE_TURN_PREFIX`/`isWakeTurnId`
  `packages/protocol/src/session.ts:311-315`; `refuseWakeTurnId`
  `packages/daemon/src/connection.ts:1036`; `UPDATE_CLASS`
  `packages/protocol/src/updates.ts:471`; `JobRowSchema` `session.ts:656`. All hold
  as cited. **S2 needed none of them at runtime** (it is wire + client), but the
  assumption "a fire is an ordinary `prompt()` on the same slot" is what makes a
  DISPLAY-class update + a plain method the right shape here, so it was checked
  before designing anything. No contradiction → not blocked.

**Plan contradiction found and fixed in the doc (D5, plus the slice table).**
D5 said "`OpenResult.schedules?` (first page, like `jobs`)". The code says
otherwise: `jobs` rides **`SnapshotResult`** (`session.ts:755`), not
`OpenResultSchema` (`:938`) — `OpenResult` is the open's own report, and the list
state is the snapshot's first page. Implemented at the verified site
(`SnapshotResult.schedules`), and D5 + the S2 row of the slice table now say so.
Nothing else in the plan contradicted the code.

**Red first** (§9), three files, each shown failing on the un-implemented code:

| test file | red | why it failed |
|---|---|---|
| `packages/protocol/test/schedule-rows.test.ts` | 16 fail / 1 pass | `ScheduleRowSchema`, `Method.ScheduleDelete`, `schedules` not exports |
| `packages/client/test/schedules.test.ts` | (compile-red) `tsc`: `remote-session.ts` has no `schedules`/`onSchedules`/`deleteSchedule`; `mapping.ts:248` "lacks ending return statement" — the new variant is unhandled | |
| `packages/daemon/test/watch-queue.test.ts` (new test) | 1 fail | `schedules` not in `DROPPABLE` → the queue overflowed and ended the watch |
| `packages/daemon/test/mapping.test.ts` (found by the FIRST full run) | 1 fail | the daemon's exhaustive sample table had no `schedules` entry |

The client red was a **compile** red, which §9 forbids as proof on its own; after
the module and the mapping arm existed, the behavioural reds were re-taken as
mutations (M1/M2/M3/M5/M10/M11 below), which is the real non-vacuity evidence.

**As built (dependency order).**
1. **`packages/protocol/src/session.ts`** — `ScheduleRowSchema` (+ `ScheduleRow`),
   `ScheduleIdSchema`, `SCHEDULE_LABEL_MAX = 200`, `ScheduleDeleteParamsSchema`
   / `ScheduleDeleteResultSchema` (`{deleted, reason?}`); `SnapshotResult.schedules?`;
   `SessionListEntry.schedules?: number`.
2. **`packages/protocol/src/updates.ts`** — `SchedulesUpdateSchema` (full list),
   its member in `SessionUpdateSchema`, `UPDATE_CLASS.schedules = "display"`,
   `TurnStartSchema.schedule?: {id, spec}`.
3. **`packages/protocol/src/methods.ts`** — `Method.ScheduleDelete =
   "session/schedule_delete"` + its `RequestSchemas` entry.
4. **`packages/client/src/schedules.ts`** (new) — `boundSchedules`,
   `schedulesFromSnapshot`, `sanitizeScheduleText`, `MAX_SCHEDULE_ROWS = 32`,
   `SCHEDULE_LABEL_CLIENT_MAX = 200`, `SCHEDULE_OLD_DAEMON`,
   `SCHEDULE_UNTRUSTED_DAEMON`. The client is the gate (AGENTS §7).
5. **`packages/client/src/mapping.ts`** — `schedules` joins the "owned elsewhere,
   no `AgentEvent`" arm; `SessionEvent`'s `user_message` gains the optional
   `schedule` ref.
6. **`packages/client/src/remote-client.ts`** — `SessionSchedulesNotice`,
   `scheduleListeners`, `SessionEntry.schedules`, `Snap.schedules`,
   `schedulesChanged`, `onSessionSchedules`/`schedulesOf`/`deleteSchedule`, the
   live dispatch arm and the resync fold — **both gated on `daemonWakes`**;
   `index.ts` exports the new module.
7. **`packages/client/src/remote-session.ts`** — `get schedules`,
   `onSchedules(listener)`, `deleteSchedule(id)` (which refuses locally when the
   trust bit is off, so a pod can neither claim nor cancel a wake).
8. **`packages/daemon/src/watch-queue.ts`** — `schedules` added to `DROPPABLE`
   (a display-class list must be skippable, never end a watcher).
9. **`packages/protocol/schema/protocol.json`** — regenerated with
   `bun run schema:export` (+120 lines: the 3 new `$defs`, the method, the
   `x-event-class: display` annotation). No hand edit.
10. Fixtures: `json-schema.test.ts` gains the `session/schedule_delete`
    params/result, a snapshot with `schedules`, two `turn_start`s (plain + fired)
    and two `schedules` updates — the fixture table is exhaustive, so a new wire
    position without one fails.
11. **`packages/daemon/test/mapping.test.ts`** — the sample table there is
    exhaustive against `UPDATE_CLASS` by design ("keeps the samples honest"), and
    the full suite caught the missing `schedules` sample (1 fail). Added; that
    red-then-green is the suite doing its job, not a new behaviour.

**Drift from Implementation (all deliberate, each with its reason):**
1. **`SnapshotResult.schedules`, not `OpenResult.schedules`** (above).
2. **`spec`/`prompt` are `z.string()`, NOT `line()`.** D5 said "lenient like
   `JobRow`", and `line()` is the opposite: a known type failing its member is an
   **error** the client reports (`mapping.ts` `classifyUpdate`), so one label with
   a newline would have killed the WHOLE list instead of sanitising one row. Found
   by the hostile-frame test going red — the behaviour, not a reading. The daemon
   still cuts to `SCHEDULE_LABEL_MAX`; the client sanitises and cuts to its own
   cap. `kind` is a free `z.string()` for the same reason (`JobRow.status`).
   The ID stays bounded (`ScheduleIdSchema`, ≤ 64): it keys a method.
3. **`ScheduleDeleteResult.reason?` added.** Without it a refusal had no way to
   say why (an unknown id, an older daemon, an untrusted client), and the TUI
   needs a notice — the `{deleted:false}`-only shape D5 sketched would have made
   three different refusals indistinguishable.
4. **The client refuses `deleteSchedule` locally with the bit off.** D5 said "a
   client shows `schedules` and offers delete only when `daemonWakes` is on". A UI
   *offering* is not a guarantee (§7: a daemon-side check is UX, never security),
   so the gate is in the code path, not only in the panel S5 will paint.
5. **`watch-queue.ts`'s `DROPPABLE`** was not in the plan's file list (the plan
   puts the watcher nowhere). A new display type left out of that table would end
   a follower's watch on `overflow` — exactly the silent-drop class §8 says to
   design out. One line + one test.
6. **`SCHEDULE_UNTRUSTED_DAEMON` / `SCHEDULE_OLD_DAEMON`** are two constants, not
   one: "your daemon is too old" and "your daemon is not trusted to do this" are
   different sentences for a user.

**Mutation checks** (§9; each applied to the source, the named test file re-run,
then restored from `.tentacle/tmp/cron-tool/*.bak` with `diff -q` clean after
every one):

| # | Mutation | Red |
|---|---|---|
| M1 | drop the `daemonWakes` gate on the live `schedules` dispatch | 1 fail: `with the bit OFF (a pod, run/attach) the frame is DROPPED` |
| M2 | drop the gate on the resync fold | 1 fail: `a snapshot's list is adopted only with the bit ON` |
| M3 | paint `spec`/`prompt` as sent (no sanitising) | 2 fail: `every label is one line, escape-free…`, `300 rows with control chars…` |
| M4 | remove `schedules` from `DROPPABLE` | 1 fail: `a schedules frame is DROPPABLE` |
| M5 | drop the local untrusted-daemon refusal in `RemoteSession.deleteSchedule` | 1 fail: the pod test (it now sends the method) |
| M6 | `UPDATE_CLASS.schedules` → `"mandatory"` | 1 fail: `the update is a DISPLAY class member` |
| M7 | drop the `RequestSchemas` entry for the method | 1 fail: `the method is registered with its params and result` |
| M8 | drop the 32-row bound | 3 fail: both bounding tests + the hostile-frame test |
| M9 | drop `schedules` from `mapping.ts`'s arm | `tsc` red only (`TS2366`, function lacks ending return) — a compile gate, stated as such, not counted as a test red |
| M10 | take the notice's `count` AFTER the client's bound | 1 fail: `the count is unbounded` (`32`, wanted `300`) |
| M11 | make `updateToEvent` emit an event for `schedules` | 1 fail: `updateToEvent returns null for it` |

M1/M2 are the pair that proves the trust bit is pinned at BOTH doors (live frame
and snapshot); M10 proves the count is the daemon's, not the client's slice.

**Gate.**
- `bunx tsc --noEmit` → 0 · `bun run typecheck` (root + mobile + relay) → 0.
- `bun run lint` (`biome check .`, 1670 files) → **clean**, no fixes, no warnings.
- Narrow: `bun test packages/protocol` → 438 pass / 0 fail (46 files);
  `bun test packages/client` → 766 pass / 0 fail (70 files);
  `bun test packages/daemon/test/watch-queue.test.ts` → 16 pass / 0 fail.
- Full `bun test` → **12108 pass, 5 skip, 0 fail** (864 files, 447.7 s). The five
  skips were confirmed one file at a time: `k8s/test/integration.live` +
  `cli/test/workload-shell-live.k8s` (`TENTACLE_K8S_SERVER`),
  `docker/test/integration.live` + `cli/test/session-hop.docker`
  (`TENTACLE_DOCKER_TESTS=1`), `daemon/test/ws-server` (`TENTACLE_SLOW_TESTS=1`) —
  AGENTS §6's three opt-ins across five files. **No new skip.**
- Schema regenerated (`bun run schema:export`); the drift test is green.
- **No `protocol.d/` note and no `PROTOCOL_VERSION` edit**: everything added is
  additive (a display-class update, a new method, optional fields, a count), which
  §7 says needs neither.
- Changelog: `changelog.d/cron-tool.added.md` already existed for S1 and covers
  the user-visible feature these surfaces carry (the list, the delete, the styled
  fired row); S2 adds no NEW user-visible behaviour of its own, so no second
  fragment — `CHANGELOG.md` untouched. **Verifier:** if the reviewer prefers a
  separate `cron-tool.changed.md` for the wire shape, that is a one-line addition.

**S2: DONE.** S3–S6 not started (per the slice instruction). Carried to S3: the
daemon side must emit `schedules` on every change (create, delete, fire, expiry,
failure stop), put the table on the snapshot's first page, answer
`session/schedule_delete` synchronously, stamp `SessionListEntry.schedules`, and
pass `schedule: {id, spec}` on a fired `turn_start` — the wire is ready for all
five.

### S3 — daemon (table, timer, fire, persistence)

*— claude-opus-5-5, 2026-11-16*

**Scope: S3 only** (S1/S2 done above; S4–S6 untouched: no tool, no wiring, no
config, no UI).

**Load-bearing check re-run first** (this branch @ `19fc2cd4`), before any edit:
`HostedSession.prompt` (`hosted-session.ts:2307` then) is synchronous up to the
ack and takes the slot through `assertIdle()` (`:2730`); the job-exit wake
already calls it with no request (`maybeWake`, `:2942-2967`);
`WAKE_TURN_PREFIX`/`isWakeTurnId` at `protocol/src/session.ts:311-315`; a client
`wake-` id refused at `connection.ts:1048`; `finishTurn` (`:2866`) persists then
`kickWake`s outside the steering window; `persister.schedule` captures
synchronously (`session-persister.ts:152-169`, `write` → `capture` before any
await). **All hold — not blocked.** **Repro (feature missing):** `rg
"scheduleLink|scheduleTable|schedules" packages/daemon/src` → one hit only
(S2's `watch-queue.ts:75` `DROPPABLE`); the new test file's first run: **0 pass /
4 fail**, `TypeError: hosted().scheduleLink is not a function`.

**Plan fix before coding (owner Q7 = keep).** D7's `/clear` row, the `/clear`
failure-mode row and T-D6 said "drop + notice"; updated in place to "kept; the
archived fork carries none".

**As built (dependency order).**
1. `packages/core/src/schedule.ts:440` — `ScheduleLink` (type only): `now`,
   `create`, `list`, `delete`, all synchronous. The seam S4's tools call.
2. `packages/daemon/src/schedules-view.ts` (new, pure): `scheduleRows` (one-line
   labels cut to `SCHEDULE_LABEL_MAX`; `expiresAt` only for `every`),
   `sameScheduleRows`, `scheduleSeqSeed`, `scheduleEndOf`, `parseScheduleRecords`.
3. `packages/daemon/src/hosted-session.ts` — `SessionSchedules` option (`:423`;
   present = on; `onAudit`, injectable `setTimeout`/`clearTimeout`) as a new last
   constructor parameter; table/seq/timer/`lastSchedules`/`firedTurns` fields;
   `Cut.schedules`; restored table + seeded counter + `armSchedules()` in the
   constructor. `scheduleLink()` (`:3095`, `null` without the option or once
   closed); `deleteSchedule` (`:3138`, the user's method, synchronous, a refusal
   carries `reason`); `checkSchedules` (`:3167`, the timer's body: the gate is
   `wakeDue({pending:true},{enabled:true, idle:!running, blocked:closed})` — no
   `lastEndBad` — then `scheduleStep(…, { idle })`); `fireSchedule` (`:3197`:
   commit the advanced table → `persist()` → publish → `recordCut(null)` +
   `wakeUnflushed` like `maybeWake` → `prompt(wake-<uuid>, [prefixed text], …,
   {id, spec})`); `settleFired` (`:3232`, from `finishTurn` `:2995`, state first);
   `armSchedules`/`disarmSchedules`/`kickSchedules` (ONE timer, ≤ 60 s, 60 s
   while busy, 0 after a turn's or compaction's end `:3023`, `:3536`);
   `publishSchedules` (`:3286`, full list on change, cut moves when idle). `prompt()`
   gained an optional 6th parameter `schedule` → `turn_start.schedule` (`:2446`);
   `Connection` never passes it, so no client can claim a fire. `close()` disarms
   (`:3709`); the table stays (archive). `persistedState` writes `schedules` only
   when non-empty; `summary` gives the count where the host schedules (`:1767`);
   `liveness().busy` counts an armed table (owner Q5, `:1784`); the snapshot's
   first page carries `schedules` where the host schedules (`:1915`).
4. `packages/daemon/src/persisted-session.ts:100,148` — `schedules?` on
   `DaemonSessionState` and `DaemonSessionRecord`; `session-persister.ts:546`
   copies it (non-empty only).
5. `packages/daemon/src/daemon-state-file.ts` — `DAEMON_STATE_VERSION_SCHEDULES =
   3` (`:70`), `DAEMON_STATE_VERSIONS = [1, 2, 3]`; `sidecarOf` stamps 3 exactly
   when the table is non-empty (`:130`), else the old 1/2 rule; `parseSidecar`
   refuses `schedules` in a v1/v2 file (`:387`) and a malformed table; `rebuild`
   carries it.
6. `packages/daemon/src/session-host.ts` — `SessionHostOptions.schedules` (`:355`);
   `AgentContext.schedules` (`:141`), passed lazily in `build` (`:1397`) AND
   `updateSettings` (`:1481`) only when the option is set; `build` hands the option
   to the session (`:1432`); `restore` hands `record.schedules` back for a restart
   and a reopen alike (`:1235`).
7. `packages/daemon/src/connection.ts:440` — `session/schedule_delete` →
   `deleteSchedule` (synchronous). `session-list.ts:44,98` — the count.

**Drift from Implementation (each deliberate):**
1. **`SessionHostOptions.schedules` carries no limits.** The plan says "(config
   limits)", but S1's core rules use constants (`SCHEDULE_MAX_JOBS`, …), and
   `schedules.*` config is S4's slice. The option is `{ onAudit?, setTimeout?,
   clearTimeout? }`. **Carried to S4:** wiring `schedules.*` config needs the core
   functions parameterised (or the config rejected outside the defaults).
2. **The timer is injectable** (`SessionSchedules.setTimeout`/`clearTimeout`, the
   `startReaper` precedent). The default is the global, `unref`'d, so a schedule
   never keeps a worker process alive on its own. This is what lets the tests pin
   "busy → 60 s, never a 0 ms spin" and "close clears the timer" without sleeping.
3. **New pure module `schedules-view.ts`** (not in the file list): the row
   projection, the counter seed, the sidecar validation and the end mapping are
   branching logic, so they live outside `HostedSession` (AGENTS §7).
4. **The `sc-N` counter is not persisted.** It is seeded from the table and every
   `sc-N` the history mentions (a fired prompt, a create's result text), so a
   reload never hands out an id the model has seen. No extra sidecar field.
   Over-counting only skips numbers.
5. **No "notice" frame for an expiry or a failure stop.** D3 says "with a
   one-line notice". S2 added no notice update type, and S3 adds no protocol. The
   daemon publishes the `schedules` list (the row disappears) and writes an audit
   line (`schedule: sc-1 expired S` / `schedule: sc-1 stopped after failures S`).
   **Carried to S5:** derive the user-facing notice from the list diff, or ask for
   a display-class notice type. **Reviewer: confirm this is acceptable.**
6. **`SessionListEntry.schedules` is live-only.** An archived entry omits it: its
   wakes are frozen and do not fire, and the archived index reads only the
   sidecar header line.
7. **`ScheduleLink` lives in core** (`schedule.ts`): the tools package cannot
   import the daemon, and the plan did not say where the type goes.
8. **Two existing tests used `schemaVersion: 3` as "an unknown version"**
   (`daemon/test/persistence.test.ts:1337`, `cli/test/serve-persistence.test.ts:426,447`).
   3 is now valid, so they use 4 and the new message (`is not 1 or 2 or 3`).
9. **T-D10 covers the daemon half only:** a host without the option gives no
   link, no `AgentContext.schedules`, no snapshot list, no count, and delete is
   refused. `podSessionHost` passes no option (the option is new), and the
   "tools absent" half belongs to S4's wiring test.
10. **Not S3, carried:** the `move_session` hop's "N scheduled wakes dropped"
    notice (D7), the worker passing the option + `daemonWakes` (S4).

**Tests** — `packages/daemon/test/schedules.test.ts` (new, 16): real `SessionHost`
+ `Connection`, scripted model, injected clock and timer, no real sleeps.
T-D1 fire; T-D1b `turn_start.schedule` + every list frame; T-D2 busy (no fire, no
lost slot, 60 s poll, one catch-up fire at the end); T-D3 advance-before-fire
(every capture naming the fired turn has the slot moved; a `SessionPersister`
subclass records the captures); T-D4 restart past two slots → one fire, v1 → v3 →
v1 on disk, no id reuse; T-D5 held ask → busy, no second fire, an answer
completes, the next fire follows; T-D6a `/clear` keeps + the fork carries none;
T-D6b compaction keeps + the rebuilt agent gets the same link; T-D7 close
disarms, archive keeps the table frozen, `reopen` re-arms and catches up once;
T-D8 an armed table keeps a detached session out of the idle TTL; T-D9 the delete
method answers mid-turn, plus snapshot/list/count; T-D10 no option → nothing;
T-D11 three failed fires remove the job, and a failed turn does not block the
next fire; three v3-sidecar tests (round trip; v1/v2 carrying `schedules`
refused; malformed table refused).

**Mutation checks** (each applied to the source, this file re-run, the source
restored from `.tentacle/tmp/cron-tool/{hs,sh,dsf}.s3.bak`, `diff -q` clean after
every one):

| # | Mutation | Red |
|---|---|---|
| M1 | skip `prompt()` in `fireSchedule` | 10 fail (every test that fires) |
| M2 | drop `schedule` from the fired `turn_start` | 1: T-D1b |
| M3 | `scheduleStep(…, { idle: true })` whatever the slot | 2: T-D2, T-D5 |
| M4 | commit the advanced table after `prompt()` (microtask) | 1: T-D3 |
| M5 | `restore` drops `record.schedules` | 2: T-D4, T-D7 |
| M6 | `/clear` empties the table | 1: T-D6a |
| M7 | `updateSettings` stops passing the link | 1: T-D6b |
| M8 | `close` does not disarm | 1: T-D7 |
| M9 | drop the table term from `liveness().busy` | 1: T-D8 |
| M10 | `deleteSchedule` calls `assertIdle()` | 1: T-D9 |
| M11 | the link handed to the factory unconditionally (a pod would get it) | 1: T-D10 |
| M12 | drop `settleFired` from `finishTurn` | 1: T-D11 |
| M13 | fires honour `lastEndBad` | 1: T-D11 |
| M14 | accept `schedules` in a v1/v2 sidecar | 1: the v1/v2 refusal test |
| M15 | drop `kickSchedules()` at a turn's end | 1: T-D2 |

M3 is Round 2's carried requirement ("`idle: true` hard-coded → red"). M11 pins
the pod exclusion at the host. M14 pins the "older build refuses, never drops"
version rule.

**Re-verification (a second executor pass, same slice; the first stopped at
the gate).** The `{hs,sh,dsf}.s3.bak` backups named above no longer existed, so
the table above was treated as unverified and re-run from scratch.
1. Load-bearing check re-run on the current tree: `prompt` `:2399` → `assertIdle()`
   `:2424` (defined `:2826`); `maybeWake` `:3049` uses the same `wakeDue`;
   `finishTurn` `:2962` persists, then `kickWake` `:3019` and `kickSchedules`
   `:3023` outside the steering window; `connection.ts:1054` refuses a client
   `wake-` id; `protocol/src/session.ts:311-315`. **Holds.**
2. All 15 mutations re-applied by a script
   (`/Users/gmeghnag/tentacle/.tentacle/tmp/cron-tool/mut-s3.ts`: one exact
   substitution per mutation, refused unless its site matches exactly once;
   the S3 test file is run; the original bytes are written back and compared).
   Every one is **red with exactly the tests listed above** (M1: 10 fail; M3, M5:
   2; all others: 1), and every file was `restored`. Nothing in the source changed
   in this pass.
3. Changelog: `changelog.d/cron-tool.added.md` already exists on the branch
   (one bullet for the whole feature), so S3 adds none. No schema changed in S3,
   so `protocol.json` was not regenerated (the `json-schema` drift test passes).

**Gate** (2026-11-16, this tree): `bunx tsc --noEmit` clean · `bun run lint`
clean (1684 files, 0 issues) · `bun test` **12195 pass / 5 skip / 0 fail**
(874 files). The 5 skips are the opt-in group, the same count as S2's full run
before the S3 diff (`fulltest-s2b.log`: 5 skip), so no skip is new.
`bun test packages/daemon/test/schedules.test.ts`: 16 pass / 0 fail.

*— claude-opus-5-5, 2026-11-16 (re-verification + gate)*

**S3: DONE.** S4–S6 not started (per the slice instruction).

### S4 — tools + wiring (the tools, config, which hosts offer them, the worker trust bit)

*— claude-opus-5-5, 2026-11-16*

**Scope: S4 only.** No TUI or mobile changes (S5/S6), and no protocol change.

**Load-bearing check, re-run first** (this tree, before any edit):
- `prompt()` is at `hosted-session.ts:2399` and takes the slot through
  `assertIdle()` at `:2424`.
- `connection.ts:1054` refuses a client `wake-` id; `WAKE_TURN_PREFIX` and
  `isWakeTurnId` are at `protocol/src/session.ts:311-315`.
- S4's own preconditions hold. P1: the lazy link is passed in `build` and in
  `updateSettings` (`session-host.ts:1397`, `:1481`). P2: `workload_shell` and
  `move_session` are already gated per host (`wiring.ts`). P4: the child filter
  is at `subagent.ts:395`. P11: the worker sets `sharedAutoAccept`, and only
  `connect` sets `daemonWakes` (`connect.ts:231`).

**Not blocked.**

**Repro (feature missing):** no `schedule_create` or `schedule_control` was
registered anywhere. The new host test's first run, after `scheduleLimitsOf`
existed but before the wiring: **2 pass / 2 fail**. The worker and `serve` were
offered neither tool; the pod test was already green.

**As built (dependency order; each step red first):**
1. **Core limits** (`core/src/schedule.ts:46` `ScheduleLimits`, `:55`
   `DEFAULT_SCHEDULE_LIMITS`). `parseScheduleSpec(…, limits)` and
   `scheduleCreate(…, {limits})` take the host's limits; the default is owner
   Q6's. Refusal texts now name the real limit (`at least 5m`, `more than 1d
   ahead`). `ttlMs` is also the longest `every`: an interval longer than the
   job's life would never fire. This replaces the separate 7 d interval cap,
   with the same default.
   - Red: 4 assertion failures. Green: 39/39.
2. **Daemon** (`hosted-session.ts:431`): `SessionSchedules.limits?`, passed to
   `scheduleCreate` (`:3122`).
   - T-D12 in `daemon/test/schedules.test.ts`: red, then green (18/18).
3. **Tools** (`tools/src/schedule.ts`, new; exported from `tools/src/index.ts`):
   - `createScheduleCreateTool(link)`: `permission: "ask"`; a flat
     `{prompt, every?, at?}`.
   - `createScheduleControlTool(link)`: `permission: "none"`;
     `{action: list|delete, id?}`.
   - Concurrency: `list` reads `schedules`, `delete` writes it, and garbage
     input is `"exclusive"`.
   - The link is looked up on every call; `null` (the session ended) gives a
     tool error.
   - `scheduleClock` formats times in the host's zone.
   - Labels: `Schedule` / `Schedules` (`core/src/tool-labels.ts`).
4. **Child filter** (`agent/src/subagent.ts:403`): both tool names are added.
   - `agent/test/subagent-schedule.test.ts`: red (a `general` child was offered
     both), then green.
5. **Config `schedules.*`**: file-only, never carried, every key
   per-key-mergeable in a profile.
   - Keys: `maxJobs` (1–100, default 10), `minIntervalMinutes` (1–1440, default
     1), `expiryDays` (1–30, default 7), `maxAheadDays` (1–30, default 7),
     `promptMaxChars` (1–20000, default 2000).
   - Edited: `schema.ts:414`, `resolve.ts:100` (`SchedulesConfig`, with
     `sources` entries like `contextAwareness`), `load.ts`, `profile.ts`,
     `defaults.ts` (constants and a template comment line), `key-docs.ts`.
   - The README config table was regenerated with `bun run docs:config`
     (+5 rows).
   - `config/test/schedules.test.ts`: red 4, then green 4.
6. **Wiring** (`cli/src/wiring.ts`):
   - `scheduleLimitsOf(config)` (`:443`) turns minutes/days into the core's ms.
   - `BuildAgentOptions.schedules` (`:432`) registers both tools only when
     present (`:723`).
   - Factories: `workerAgentFactory` (`worker.ts:52`) and `createServeAgent`
     (`serve.ts:212`) pass `ctx.schedules`.
   - Hosts: `workerSessionHost` passes `schedules: {limits}` (`worker.ts:118`);
     `serve` passes `{limits, onAudit}` (`serve.ts:778`).
   - `podSessionHost` / `tunnelledAgent` are untouched, so a pod gets no table,
     no link and no tools.
   - `cli/test/schedule-hosts.test.ts`: one real turn per host, asserting
     `ChatRequest.tools`. Red 2 (worker, serve), then green 4.
7. **Worker trust bit** (`cli/src/local-runtime.ts`):
   - `WORKER_TRUST = {sharedAutoAccept, daemonWakes}` (`:1471`) is spread at the
     worker call site (`:1552`).
   - `LocalRuntimeDeps.daemonWakes` (`:929`) is forwarded to `RemoteClient`.
   - `persistingController` now forwards `autoAcceptsTurn` (`:765`, which keeps
     `adoptedTurn`).
   - Comments that said "only `connect` sets `daemonWakes`" were updated
     (`remote-client.ts`, `remote-session.ts`, `connect.ts`).
   - `cli/test/worker-daemon-wakes.test.ts`: red 3 (the controller had no
     `autoAcceptsTurn`), then green 3.

**Drift from Implementation (each deliberate):**
1. **The plan was missing one link (now fixed in D1).** The worker setting
   `daemonWakes` did not make its TUI auto-accept a `wake-` turn, because
   `persistingController` exposed only `ownsTurn`. S4 forwards
   `autoAcceptsTurn`. For pods and the relay (bit off) it equals `ownsTurn`, so
   nothing changes there. `relay-policy.ts` still reads only minted turns.
2. **Core limits are parameterised** (carried from S3's drift 1). This touches
   S1/S3 code minimally: one optional argument, defaults unchanged, and S1's
   tests are untouched and green.
3. **Config key names were chosen here** (the plan only said `schedules.*`).
   They use unit-suffixed integers (the `toolOutputRetentionDays` style) and
   have no env vars: file-only, like `contextAwareness`.
4. **Tool result texts differ slightly from D2's sketch:**
   - The fired text quotes `· fire N`, because that is what `schedulePromptText`
     really sends.
   - A one-shot reads `one-shot at 16:20 (in 2h).`, with no expiry.
   - The closing sentence is the runtime-neutral "It lasts while this session
     runs." The tool cannot tell `serve` from the worker.
5. **The permission-prompt wording (D4/M1) is not S4's.** `Tool` has no
   permission-summary hook. The ask carries the call's input, and the TUI
   renders it, so the M1 text belongs to S5.
6. **Still carried, not S4:** the `move_session` hop's "N scheduled wakes
   dropped" notice (D7), the expiry/failure notice (S3 drift 5), and the M6
   quit warning. All are S5's.

**Mutation checks.** Run by `/Users/gmeghnag/tentacle/.tentacle/tmp/cron-tool/mut-s4.ts`.
Each mutation is one exact substitution, refused unless its site matches
exactly once. After each run the original bytes are written back and compared.
All 16 were `restored=true`.

| # | Mutation | Red |
|---|---|---|
| M1 | filter drops `schedule_create` | 2: both child tests |
| M2 | filter drops `schedule_control` | 2: both child tests |
| M3 | `buildAgent` registers the tools unconditionally (a pod would get them) | 1: pod host test |
| M4 | worker host passes no `schedules` option | 1: worker host test |
| M5 | worker factory drops `ctx.schedules` | 1: worker host test |
| M6 | `serve` host passes no `schedules` option | 1: serve host test |
| M7 | `serve` factory drops `ctx.schedules` | 1: serve host test |
| M8 | `scheduleLimitsOf` ignores `minIntervalMinutes` | 1: worker host test |
| M9 | daemon `createSchedule` drops `limits` | 1: T-D12 |
| M10 | core ignores `limits.minIntervalMs` | 1: core min-interval test |
| M11 | core ignores `limits.maxJobs` | 1: core caps test |
| M12 | `WORKER_TRUST` without `daemonWakes` | 1: call-site pin |
| M13 | `createLocalRuntime` does not forward `daemonWakes` | 1: auto-accept test |
| M14 | controller `autoAcceptsTurn` answers `ownsTurn` (the pre-S4 fallback) | 1: auto-accept test |
| M15 | `schedule_create` permission `none` | 1: tools "asks" test |
| M16 | `delete` ignores the link's answer | 1: tools delete test |

The plan names two targets: "remove from filter → red" (M1/M2) and "`wiring`
offers them only with the link" (M3–M7).

**Gate** (2026-11-16, this tree):
- `bunx tsc --noEmit`: clean.
- `bun run lint`: clean (1701 files).
- `bun test`: **12287 pass / 5 skip / 1 fail** (12293 tests, 885 files).
  - The 5 skips are the opt-in group, the same count as S3.
  - The 1 fail is `packages/exec/test/confinement.test.ts` "R2-4: a hard-linked
    file INSIDE the root is writable again" (`Expected "new" / Received "old"`).
    The `exec` package is untouched by this diff (`git diff --stat --
    packages/exec` is empty). It passed twice in isolation (46/46) and with the
    whole `exec` package (105/105), so it is a flake under full-suite load, not
    an S4 regression. It was not reproduced on a clean tree, because a stash or
    checkout is not allowed here.
- No protocol schema changed, so `protocol.json` was not regenerated; the
  `json-schema` drift test passes.
- Changelog: the existing single fragment `changelog.d/cron-tool.added.md` gains
  one sentence (it asks first; `schedules.*` limits). The changelog tests pass.

**S4: DONE.** S5–S6 not started.

## Review

### S1 — REQUEST-CHANGES

*— claude-opus-5-5, 2026-11-16* (fresh context; **same model as the S1 executor**,
so the two passes share blind spots.)

**Findings**
1. **HIGH: the fire order is the table order, not "the older `nextAt` fires" (D3).**
   `packages/core/src/schedule.ts:336-346` fires the first overdue job in creation
   order. Repro (`.tentacle/tmp/cron-tool/order.ts`): sc-1 `every 1h`, sc-2 `every 5m`,
   check at +90m → fires **sc-1**, but sc-2's `nextAt` is the older one. The test
   `schedule.test.ts:240` passes only because there the older job is also first in
   the table, so it can't catch this (it passes on both orderings).
2. **HIGH: starvation follows from 1.** sc-1 `every 1m` (each fired turn takes about 2m)
   plus sc-2 `every 10m`: over 30 checks sc-1 fires every time and **sc-2 fires 0
   times** (same repro). Every idle check finds the first job already overdue again,
   so any job created after a short-interval one never fires. That breaks "one
   turn each" and the coalesce failure mode. Fix: pick the overdue job with the
   minimum `nextAt` (ties go by table order). Add a test where the table order and
   the `nextAt` order differ, plus a starvation test.
3. **MEDIUM (a hazard handed to S3): `scheduleCheckDelayMs` returns 0 whenever a job
   is overdue** (`schedule.ts:415-418`). While the session is busy a job stays
   overdue, so re-arming from this value every check spins `setTimeout(0)`. And
   `scheduleStep` advances any due job, so calling it while busy (for example just
   to sweep expiry) loses the slot. The function or its docstring must say "call
   only when idle; while busy do not arm the timer, `kickWake` re-checks", and the
   S3 tests should pin it.

**Gate (touched scope):** `bun test packages/core/test/schedule.test.ts` → 31 pass / 0
fail; `bun run lint` → clean (1660 files); `bun run typecheck` → 0. Full suite not
re-run: S1 is a new leaf module.

**Mutation (my own):** `slotAfter` → `now + interval` (drift instead of the grid) →
1 fail (`catch-up ONCE…`). Restored from a backup, and `git status` is clean. The
executor's M1–M8 table holds as described, but for finding 1 the ordering test is
vacuous.

**Premises:** the cited `hosted-session`/`connection`/`session.ts` lines are not used by
S1 (pure module), so they are not re-verified here. They are S3's to prove.

**Attacks tried:** ordering with table order ≠ `nextAt` order → **bug (1)**; starvation
→ **bug (2)**; `at` edge cases: `+0100` accepted, `10:61` refused, `24:00Z` accepted
as the next midnight (low, not counted), Feb 30 with an offset rolls over and is
refused only because it lands in the past (low); back-jump clamp on a fresh job (not
clamped, correct); expiry on an overdue `every` (removed, not fired, correct).

**What holds:** advance-before-fire, catch-up once, the clamp, the expiry, failure stop
3, cancel neither counts nor resets, the 10-job cap, the immutable table, no `!`
assertions, no I/O. **Executor:** red first and mutations recorded, drift declared
honestly. It missed that its ordering test cannot fail.

### Fix round 1

*— claude-opus-5-5, 2026-11-16* (fixing the S1 review above; same model id as the
reviewer, so a fresh-context review of this round is still owed.)

**Findings addressed: all three (2 HIGH + 1 MEDIUM).**

**Repro before the fix** (`.tentacle/tmp/cron-tool/order.ts`, on this branch @
`4b2e6b2d`) → `3 finding(s) reproduce`:
```
nextAt sc-1/sc-2: 3600000 480000 (minutes)
FAIL the older nextAt fires: got "sc-1" want "sc-2"
fires over 30 idle checks: {"sc-1":30}
FAIL both jobs fire: got [30,false] want [true,true]
FAIL an overdue job does not ask for a 0 ms spin: got 0 want null
```
Same script after the fix → `REPRO NOT PRESENT` (`sc-2` fires first; 30 idle
checks give `{"sc-1":25,"sc-2":5}`; the busy delay is 60000).

**Root cause, one sentence each:**
1+2. `scheduleStep` took the FIRST overdue row in table (= creation) order, so
the fire order was the row order, not D3's "the older `nextAt` fires" — which
also let a short-interval job re-arm before every check and starve every job
created after it (`schedule.ts:336-346`).
3. `scheduleCheckDelayMs` floored at 0 for an overdue job with no notion of a
busy session, so re-arming from it while a turn held the slot spun
`setTimeout(0)`; and `scheduleStep` advanced a due row even when busy, burning
the slot.

**As built**
- `packages/core/src/schedule.ts:318-330` — new exported
  `ScheduleStepOptions { idle: boolean }`, docstring naming both hazards.
- `:335-390` — `scheduleStep(table, now, options)` split in two passes: expiry +
  back-jump clamp first (table order preserved, so the wire row order is still
  creation order), then ONE pick = the overdue job with the **smallest `nextAt`**
  (ties to table order), then the existing advance-before-fire on that one row.
  `{ idle: false }` returns after the first pass: `due: null`, nothing advanced.
- `:443-460` — `scheduleCheckDelayMs(table, now, options)`: `{ idle: false }` →
  `SCHEDULE_CHECK_INTERVAL_MS` (60 s), never 0; docstring says the timer is
  re-armed by `kickWake` at the turn's end, so a slow poll is all a busy session
  needs.
- **`options` is REQUIRED on both, deliberately not defaulted.** A default of
  `{ idle: true }` would reinstate exactly this finding at any call site that
  forgets it (spin or a silently burnt slot); a compile error is the correct
  outcome. This makes the flag a compile-time contract for S3.

**Drift from Implementation:** none in the rules; D3's fire-order and
busy-coalesce text is unchanged and now actually implemented. The
Implementation's D3 tick paragraph was updated in place to name the required
`{ idle }` flag (it described `scheduleStep(table, now)` with no busy mode, which
is what let finding 3 through).

**Red first** (per §9; every new/changed test shown failing on the pre-fix code):
- ordering test `the OLDER nextAt fires even when it is not first in the table`
  → `(fail)`, got `"sc-1"`.
- starvation test `a short-interval job does not starve a later, longer one` →
  `(fail)`, `sc-2` fired 0 times in 30 checks.
- `a busy check sweeps expiry but fires nothing and loses no slot` → `(fail)` on
  `expect(busy.due).toBeNull()` (it fired).
- `the check delay is capped at 60 s…` → `(fail)` on
  `expect(…, { idle: false }).toBe(SCHEDULE_CHECK_INTERVAL_MS)`, got `0`.
Then 34 pass / 0 fail. Note the reviewer was right that the OLD ordering test
(`two due together…`) is vacuous for the ordering bug — it is kept as the
coalesce test, and the two new tests are the ones that discriminate.

**Mutation checks** (each applied to `schedule.ts`, this test file re-run, source
restored from `.tentacle/tmp/cron-tool/schedule.r1.bak`, `diff -q` clean after
every one):

| # | Mutation | Red |
|---|---|---|
| M1 | pick the first overdue row (`if (best === undefined)`) — the old bug | 2 fail: `…OLDER nextAt… not first in the table`, `…does not starve…` |
| M2 | pick the LATEST `nextAt` instead of the earliest | 2 fail: same two |
| M3 | drop the busy early-return in `scheduleStep` | 1 fail: `a busy check sweeps expiry…` |
| M4 | drop the busy branch in `scheduleCheckDelayMs` | 1 fail: `the check delay is capped at 60 s…` |
| M5 | fire without advancing `nextAt` | 5 fail incl. the at-most-once and catch-up tests |

M1/M2 are the pair that proves the test pins the *ordering property* itself, not
merely "some job fired": a mutant that reverses the order also goes red.

**Gate**: `bunx tsc --noEmit` → 0; `bun run lint` (`biome check .`, 1660 files)
→ clean, no fixes; `bun test` → **12011 pass, 5 skip, 0 fail** (858 files, 445 s)
— exactly S1's 12008 plus the 3 new tests — and the same 5 pre-existing opt-in
skips (`TENTACLE_K8S_SERVER` ×2, `TENTACLE_DOCKER_TESTS` ×2, `TENTACLE_SLOW_TESTS`
×1): no new skip, none in `core`.
No schema/wire change, so no `protocol.d/` note and no `PROTOCOL_VERSION` edit; no
new `changelog.d/` fragment (the existing `cron-tool.added.md` still covers S1);
`CHANGELOG.md` untouched.

**Not done / for the next round:** this is a self-review-free zone — the reviewer
of round 1 shares this model id, so a fresh-context adversarial pass on round 1
is still owed (especially: whether "smallest `nextAt`" starves an `at` job against
a fast `every` job, and whether S3 honours the required flag at every call site).

### Round 2

*— claude-opus-5-5, 2026-11-16* (fresh context for this round; **same model as the
S1 executor and the round-1 reviewer**, so their blind spots are shared.)

**Verdict: PASS (S1).** All three round-1 findings are fixed by `941d816d`, and a
mutation shows each fix is pinned by a test.

| Round-1 finding | Fix (`packages/core/src/schedule.ts`) | Mutation → red |
|---|---|---|
| 1 HIGH: table order instead of the oldest `nextAt` | fires the overdue job with the smallest `nextAt`, ties go to table order (`scheduleStep`, second loop) | `job.nextAt < best.nextAt` dropped → 2 fail (`…OLDER nextAt fires even when it is not first…`, `…does not starve…`) |
| 2 HIGH: starvation | same fix | same 2 tests. The round-1 repro (`.tentacle/tmp/cron-tool/order.ts`) now gives: order → sc-2 ✓; starvation → sc-2 fires 6 of 30 (was 0) |
| 3 MEDIUM: busy spin / burnt slot | `scheduleStep` and `scheduleCheckDelayMs` now REQUIRE `{ idle }`; busy → expiry is swept, nothing fires, and the delay is 60 s, never 0 | gate removed → 1 fail (`a busy check sweeps expiry…`); busy delay dropped → 1 fail (`the check delay is capped…`) |

After each mutation the file was restored from `.tentacle/tmp/cron-tool/r2.bak` and
`git status` was clean.

**Regressions checked on the diff:** the 31 old tests now call through `idleCheck`
and are unchanged in meaning; 34 pass / 0 fail. A busy check still applies the
backwards-clock clamp, and creation order is kept for the table. Identity
filter/map on `kept` is safe (fresh array, objects are unique). The executor asked
whether an `at` job can be starved by a fast `every` job: no. The `at` job's
`nextAt` is fixed, while the fired `every` job's `nextAt` moves past `now`, so on
the next idle check the overdue `at` has the smaller value and fires.

**Gate:** `bun run lint` → clean (1660 files); `bun run typecheck` → 0. The full
suite was not re-run: the diff only touches this pure module and its test.

**Carried to S3 (not a finding):** every caller must pass the real `idle` value
(`!running && !compacting`). S3's T-D2 must pin this with a mutation (`idle: true`
hard-coded → red).

## Review

### S2 — REQUEST-CHANGES

*— claude-opus-5-5, 2026-11-16* (fresh context. The S2 executor was deepseek, a
different model family. The S1 reviewer was this same model.)

**Scope:** `git diff main...HEAD`, S2 files only (protocol, client, `watch-queue.ts`, their tests).

**Findings**
1. **MEDIUM: `turn_start.schedule` is on the wire but the client never reads it.**
   `packages/client/src/mapping.ts:48` declares `user_message.schedule?`, but neither
   place that builds a `user_message` copies it in: the foreign-turn path at
   `packages/client/src/remote-session.ts:1589` and the send-now/reset path at `:1872`.
   A wake turn reaches the client as a foreign turn, so that first path is the one
   that matters. The S2 slice row says "`TurnStart.schedule`; `client/mapping.ts`
   reverse", and §7 says to wire BOTH ends. **What goes wrong:** S3 sends
   `turn_start{schedule:{id,spec}}`, the client drops it, and S5's styled fired row
   (Q9 = B) has nothing to draw from. No test covers this, so the gap does not show.
   **The fix needs three things:** (a) carry `update.schedule` into the foreign
   turn's `user_message`; (b) only when `daemonWakes` is on, because otherwise a pod
   could make any turn look like the laptop's own scheduled wake (§7); (c) run
   `spec` through `sanitizeScheduleText`, because `turn_start.schedule.spec` is an
   unbounded `z.string()` (`packages/protocol/src/updates.ts:264`). Add a test for
   the bit ON, a test for the bit OFF, and a test with a hostile `spec`, each shown
   red first.

**Gate (touched files):** `bun test` on schedule-rows, json-schema, client
schedules, watch-queue and daemon mapping → 90 pass / 0 fail. `bun run lint` →
clean (1670 files). `bun run typecheck` → 0. The full suite was not re-run.

**Mutations** (each one restored from `.tentacle/tmp/cron-tool/rc.rv.bak`;
`git status` was clean afterwards):
- Dropping the `daemonWakes` gate on the live `schedules` arm → 1 fail (`…the frame is DROPPED…`).
- Dropping `schedules` from `firstPage`'s copy → 1 fail (`a snapshot's list is adopted only with the bit ON`).
Together these confirm that the trust bit is tested at both entry points (the
executor's M1/M2).

**Attacks tried**
- **A pod sends a `schedules` frame or snapshot.** It is dropped at both entry
  points, as shown by the mutations above. Holds.
- **A pod's client calls delete.** `RemoteSession.deleteSchedule` refuses on the
  client and sends nothing (`remote-session.ts:799`). Holds.
- **A hostile label (C0/C1 escapes, bidi controls).** It is sanitized and cut short
  in `schedules.ts`, and `spec`/`prompt` are not `line()`, so one bad row does not
  kill the whole list. Holds for the list. It does NOT hold for
  `turn_start.schedule.spec` (finding 1).
- **A watcher's queue overflows.** `schedules` is in `DROPPABLE`. Holds.
- **An older daemon.** It answers `MethodNotFound`, which becomes a typed refusal.
  Holds.
- **Not a finding:** a row id longer than 64 characters passes `ScheduleRow`
  (`.min(1)` only), but `ScheduleIdSchema` (≤ 64) rejects it in the delete
  params/`turn_start`. S3 must keep ids at `sc-N`.

**Executor behaviour:** it reported its departures from the plan honestly (the
`SnapshotResult` correction checked out against the code) and documented a strong
set of mutations. It marked S2 DONE with one of the slice's six items (the reverse
mapping of `turn_start.schedule`) only half built, and did not list that as a
deviation.

### Fix round 1

*— claude-opus-5-5, 2026-11-16* (executor of fix round 1 for the S2 review above;
**the same model id as the S2 reviewer**, so a fresh-context pass on this round is
still owed.)

**Findings addressed: the one Review finding (MEDIUM), in full — and its part (b)
turned out to have two doors, not one.**

**Repro before the fix** (`packages/client/test/schedules.test.ts`, this branch
@ `4643c40a`) — the new tests RED on the assertion of the property:
```
(fail) …the client's user_message carries {id, spec} (the bit ON…)
       @@ -1,6 +1,2 @@   - "schedule": { "id": "sc-1", "spec": "every 10m" }
(fail) …a hostile `spec` is sanitized before it can reach a terminal
       error: no schedule ref
 10 pass / 2 fail
```
The pod test (bit OFF) was green before AND after, by design: it pins "the claim
is dropped", which a client that never reads the field also satisfies. It is kept
as the guard for the trust half, not as proof of the fix — the mutations M1/M5 are
what prove that half.

**Root cause, one sentence:** `turn_start.schedule` is on the wire
(`updates.ts:264`) and `mapping.ts:48` declared the field, but neither place that
builds a `user_message` copied it in — so a fired wake reached the client as a
plain foreign turn, and S5's styled fired row (Q9 = B) had nothing to draw from.

**As built**
- `packages/client/src/schedules.ts:62-90` — new exported
  `firedScheduleRef(schedule, trusted)`: the ONE decision site for the ref. It
  returns `{}` (nothing to spread) or `{schedule: {id, spec}}`, both strings
  through `sanitizeScheduleText` (the new `SCHEDULE_ID_CLIENT_MAX = 64` matches
  the protocol's `ScheduleIdSchema`). Both gates the review asked for — (b) trust,
  (c) sanitizing — live here, so the two doors cannot drift, exactly as
  `gateExitText` does for a job's two pod-supplied strings.
- `packages/client/src/remote-session.ts:1591-1596` (**door 1**, the foreign turn
  the review named at `:1589`) — `startForeign` takes the ref and spreads
  `firedScheduleRef(schedule, this.daemonWakes)` into its `user_message`; `route`'s
  `turn_start` arm (`:1766`) passes `update.schedule` in.
- `packages/client/src/remote-session.ts:1877-1883` (**door 2**, the send-now /
  reset path at `:1872`, which the review named in the same breath) — the same
  spread, so an own turn re-delivered after a reset keeps its ref.
- **Why `remote-session.ts`, not only `mapping.ts`:** the review pointed at the
  mapping; the ref has to ride the `user_message` the SESSION pushes, so the copy
  belongs where that event is built. `mapping.ts`'s `SessionEvent` already
  declared the field (`:48`) and needed no change.

**Drift from Implementation:** none. The S2 slice row's "`TurnStart.schedule`;
`client/mapping.ts` reverse" is now satisfied end to end; D5 unchanged. No schema
or wire change (the field already existed), so no `protocol.d/` note and no
`PROTOCOL_VERSION` edit; no new `changelog.d/` fragment (S2 adds no new
user-visible behaviour of its own — the existing `cron-tool.added.md` covers the
feature); `CHANGELOG.md` untouched.

**Tests (red first, §9)** — `packages/client/test/schedules.test.ts`, +4:
1. `the client's user_message carries {id, spec} (the bit ON)` — end to end over
   the fake daemon (a `turn_start` frame → a turn activity's stream). RED: no
   `schedule` key.
2. `with the bit OFF (a pod) the claim is DROPPED` — the AGENTS §7 half. Green
   before the fix too (a client that reads nothing drops it): kept as the guard,
   proven by M1/M5 rather than by itself. Declared, not hidden.
3. `a hostile spec is sanitized` — `\u001b[2J`, `\n`, `\u202e`, 400 chars. RED:
   `error: no schedule ref`.
4. `an own turn re-delivered after a reset carries it too (the second door)` —
   drives `output({kind:"reset"})` then the replayed `turn_start`. Shown red by
   mutation M6: before the fix it cannot even compile against the field, so a
   compile-red would be the only pre-fix red — which §9 forbids as proof.
Plus 3 unit tests for `firedScheduleRef` (untrusted spreads nothing; trusted is
sanitized and bounded; absent stays absent) — the pure site, per §7 ("logic in
pure modules; components only render").

**Mutation checks** (each applied to the src, this test file re-run, source
restored from `.tentacle/tmp/cron-tool/{sch,rs}.f1.bak`, `diff -q` clean after
every one — confirmed with `RESTORED-CLEAN`):

| # | Mutation | Red |
|---|---|---|
| M1 | `firedScheduleRef`: drop the `!trusted` guard (the review's bug) | 2 fail: the pure "untrusted spreads nothing" + the end-to-end pod test |
| M2 | paint `spec` as sent (no `sanitizeScheduleText`) | 2 fail: the pure trusted-ref test + the hostile end-to-end test |
| M3 | paint `id` as sent (no strip/bound) | 1 fail: the pure trusted-ref test |
| M4 | unwire door 1 (`startForeign`'s spread) | 2 fail: the bit-ON test + the hostile test |
| M5 | hard-code `trusted = true` at door 1 (the §7 disaster: a pod's claim accepted) | 1 fail: the pod test |
| M6 | unwire door 2 (`onUpdate`'s spread) | 1 fail: "the second door" |

M1/M5 are the pair proving the TRUST bit is pinned in the code path, not only in
a component's offering; M2/M3 prove each part of the label is sanitized
separately (a `spec`-only fix would let a hostile id through); M4/M6 prove each
door is wired.

**Tried and NOT kept (declared):** after the first pass I wanted one enqueue
helper in `RemoteSession` so both doors shared a literal line. The two sites
differ in their guards (`startForeign` pushes only when prompt/refs exist;
`onUpdate` only for `sendNow || reset`), so one helper would have grown flags and
hidden those rules; the shared *decision* was extracted instead
(`firedScheduleRef`) and both call sites stay legible. A rejected shape, not a
drift from the design.

**Gate (final, on this branch):**
- `bunx tsc --noEmit` → **0**; `bun run typecheck` (root + mobile + relay) → **0**.
- `bun run lint` (`biome check .`) → **clean, no fixes, 1670 files** (one
  formatting fix on the new test file was applied with `biome check --write`
  first, as §6 prescribes; that apply is not part of the final run).
- Narrow: `bun test packages/client` → **773 pass / 0 fail** (70 files); the
  changed file alone: **16 pass / 0 fail** (up from 12).
- Full `bun test` → **12115 pass, 5 skip, 0 fail** (864 files, 443.6 s). That is
  S2's 12108 **+ 7 new tests**, and the same 5 pre-existing opt-in skips
  (`TENTACLE_K8S_SERVER` ×2, `TENTACLE_DOCKER_TESTS` ×2, `TENTACLE_SLOW_TESTS`
  ×1): **no new skip, none in `client`.**

**Not done / for the next round:** this round shares the reviewer's model id, so
a fresh-context adversarial pass on it is still owed — in particular on (a)
whether a `turn_start.schedule` arriving on a turn this session already tracks
(a wake the CLIENT did not mint) can bypass both doors, and (b) whether S5 paints
the ref without re-cutting it. Also carried unchanged from the Review: S3 must
still emit `schedules` on every mutation and pass `schedule: {id, spec}` on a
fired `turn_start`, and must spread the required `{ idle }` flag at every
`scheduleStep`/`scheduleCheckDelayMs` call site (Round 2's carried note).

### Round 2

*— claude-opus-5-5, 2026-11-16* (fresh context, the same reviewer as S2 round 1;
the executor was deepseek.)

**Verdict: PASS (S2).** `1e41c74b` fixes finding 1. `firedScheduleRef`
(`packages/client/src/schedules.ts`) is the one function that applies both the
trust check and the sanitizing. Both places that build a `user_message` now call
it: `startForeign` (`remote-session.ts:1594`, with `update.schedule` passed in at
`:1766`) and the reset re-delivery path in `onUpdate` (`:1882`).

| Mutation | Red |
|---|---|
| remove `!trusted` from `firedScheduleRef` | 2 fail (the unit test for an untrusted daemon, and the bit-OFF pod test) |
| paint `spec` without sanitizing | 2 fail (the unit sanitize test, and the hostile-`spec` test) |
| remove `firedScheduleRef` from the `onUpdate` path | 1 fail (`…re-delivered after a reset…`) |
| stop passing `update.schedule` into `startForeign` | 2 fail (the bit-ON test, and the hostile-`spec` test) |

Each mutation was restored from `.tentacle/tmp/cron-tool/*.r2.bak`, and
`git status` was clean afterwards.

**Regressions:** the change only adds data. When there is no ref or the bit is
off, the result is `{}`, so the `user_message` looks exactly as it did before (the
bit-OFF test checks the exact shape). `bun test packages/client` → 773 pass /
0 fail. `bun run lint` → clean (1670 files). `bun run typecheck` → 0. The full
suite was not re-run, because the diff touches only the client.

**Not a finding:** an id made only of control characters comes out as `""`. That
is cosmetic and comes from the trusted `serve` daemon; S3 creates ids as `sc-N`.

## Review

### S3 — REQUEST-CHANGES

*— claude-opus-5-5, 2026-11-16* (fresh context. If the executor really was Opus,
this is the same model, and its blind spots can survive both passes: see finding 2.)

Scope: `git diff main...HEAD`, S3 files only (daemon + the `ScheduleLink` type).

**Gate (touched files):** `schedules`, `persistence`, `serve-persistence`,
`watch-queue` and `mapping` tests → **191 pass / 0 fail**. `bun run lint` is clean
(1684 files). `bun run typecheck` is clean. The full suite was not re-run.

**Findings**
1. **MEDIUM: no daemon test covers the expiry path.** See `hosted-session.ts`
   `checkSchedules`, the `due === null && changed` branch. I removed BOTH
   `this.persist()` and `this.publishSchedules()` from that branch, and
   `schedules.test.ts` stayed at 16/16 green. So nothing pins the failure-mode
   row "recurring job passes 7 days → removed + `schedules` update" at the daemon.
   If that branch regresses, clients keep a dead row on screen. The sidecar also
   keeps the job until some other write happens. Fix: add a test that creates a
   job, moves the clock past `expiresAt` and checks. It must assert three things:
   a `schedules` frame without the job, a capture without it, and the audit line.
2. **MEDIUM (process, AGENTS §10 routing): who executed S3 is unclear.** The
   Execution is signed `claude-opus-5-5`. But the commit that carries the S3 code,
   `073a82b1`, is titled `exec (deepseek)`. S3 is `load-bearing`, so it needs a
   strong executor and a review by a different model. The owner should confirm
   which model wrote the code, and the signature should be corrected if needed.

**Mutations (my own; each one reverted with Edit, and `git status` is clean after):**
- Removing the constructor's `armSchedules()` → red in T-D4 and T-D7. Pinned.
- Removing persist + publish in the expiry branch → green. This is finding 1.
- Removing the `persist()` before `prompt()` in `fireSchedule` → green. This
  mutation is equivalent, not a gap: `prompt()` already persists at its own
  `turn_start`, in the same synchronous stretch, so the advance is captured
  before any await either way. T-D3 holds.

The executor's 15-row mutation table was not re-run (my scripted runner was not
approved). I spot-checked it with the mutations above instead.

**Attacks tried (no finding)**
- Firing during a compaction: `running` is `controller !== null`, which also
  covers compaction (`:1725`), so the gate holds. Compaction's `finally` calls
  `kickSchedules`.
- Firing at the same time as a job-exit wake: both run in a 0 ms macrotask. The
  loser sees `running`, re-arms for 60 s, and is kicked again at the turn's end.
  Nothing is lost, and the timer never spins.
- Reload with a suspended turn: the constructor arms the timer at 0 ms, but
  `resume` takes the controller in the same constructor. The check then sees
  the session busy, and the job fires after the resumed turn ends. Correct.
- Pod exclusion (§7): `AgentContext.schedules` is set and the table option is
  passed only when `SessionHostOptions.schedules` is set. `Connection` never passes
  `prompt`'s 6th argument, so no client can forge `turn_start.schedule`. A client
  `wake-` id is still refused.
- Peer serialization (§7): `session/schedule_delete` is synchronous, with no
  `assertIdle` (M10 pins this).
- Version rule: a v3 sidecar is stamped only when the table is non-empty, and a
  v1/v2 file that carries `schedules` is refused. `rebuild` keeps the sidecar's
  table on the unpaired path too.

**Drift 5 accepted:** there is no notice frame for an expiry or a failure stop
(the list diff and the audit line carry it). It is carried to S5 as written.

### Fix round 1

*— claude-opus-5-5, 2026-11-16* (fixing the S3 review above; same model id as the
reviewer, so its blind spots can survive both passes — a different-model review
of this round is still owed.)

**Finding 1 (MEDIUM, expiry path untested at the daemon) — FIXED.** New test
`T-D3b` (`packages/daemon/test/schedules.test.ts`, after T-D3): an attached
client + capturing persister, a `every 10m` job, the clock moved by
`SCHEDULE_TTL_MS`, one check. It asserts: never fired; `list()` empty; the last
`schedules` frame is `[]`; a NEW capture exists and carries no table; the audit
line `schedule: sc-1 expired S`. No production change: the code was right, the
pin was missing. Green on the branch code; red shown by mutation (each reverted
with Edit; `git diff packages/daemon/src` empty afterwards):

| Mutation in `checkSchedules` (`hosted-session.ts`) | T-D3b |
|---|---|
| A: drop `this.persist()` in the `due === null && changed` branch | RED — `expect(received).toBeGreaterThan(expected)` Expected `> 2`, Received `2` |
| B: drop `this.publishSchedules()` in that branch | RED — last `schedules` frame `toEqual([])`, received the old 1-row list |
| C: drop the `expired` audit line | RED — `expect(received).toContain(expected)` |

**Finding 2 (MEDIUM, process: who executed S3) — NOT FIXABLE BY CODE, escalated.**
Commit `073a82b1` (`feat(cron-tool): exec (deepseek)`) carries all the S3 code,
while the S3 Execution is signed `claude-opus-5-5`. The repo cannot tell which is
true; the owner must say. If DeepSeek wrote S3, correct the S3 Execution's
signature. S3 is `load-bearing`, so §10 then wants a strong-model fresh review
of the S3 code (Round 1's reviewer was Opus, which fits that case). This entry is
signed with the executor's real id.

**Gate:** `bunx tsc --noEmit` clean · `bun run lint` clean (1684 files, after
`biome check --write` on the test file) · `bun test` **12196 pass / 5 skip / 0
fail** (12201 tests, 874 files). All 5 skips are opt-in: k8s live ×2
(`TENTACLE_K8S_SERVER`), docker live ×2 (`TENTACLE_DOCKER_TESTS`), slow keepalive
×1. None of them is in a branch file.

### Round 2

*— claude-opus-5-5, 2026-11-16* (fresh-context reviewer)

**Verdict: PASS (S3 code).** Finding 2 is still open, and only the owner can close it.

- **Finding 1: FIXED.** The diff is test-only (`schedules.test.ts` adds T-D3b) and
  changes no production code. I re-ran the mutations myself in `checkSchedules`'s
  `due === null && changed` branch:
  - drop `persist()` → T-D3b fails (16 pass / 1 fail);
  - drop `publishSchedules()` → T-D3b fails (16 pass / 1 fail).

  I reverted both with Edit, and `git status` is clean afterwards. Unmutated:
  17 pass / 0 fail. The test also asserts "never fired", which pins that the
  expiry sweep runs before the due pick.
- **Finding 2: ESCALATED, still open.** The fix round's signature has the same
  mismatch as before. It is signed `claude-opus-5-5`, but its commit `c4af5f76` is
  titled `review round 1 (deepseek)`. The owner must say which model wrote S3 and
  this fix, and correct the signatures to match. This is not a code defect, so it
  does not block S3.
- **Regressions:** none possible in production, because no source changed.
  `bun run typecheck` is clean. `bun run lint` is clean (1684 files).

