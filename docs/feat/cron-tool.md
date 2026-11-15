# feat/cron-tool — the agent schedules its own wake-ups (recurring or one-shot)

> **Status:** implementation (plan written — awaiting owner answers; NOT approved)
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
never set it (unchanged).

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
  Each check calls the pure `scheduleStep(table, now)` → `{ due: Job | null, table' }`.
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
| `/clear` (in place) | **dropped**, with a notice (Owner Q7): they were the old chat's intentions, just as `/clear` drops the session approvals (P10) |
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
| S2 | protocol: `ScheduleRowSchema`, `schedules` update + `UPDATE_CLASS` display, `OpenResult.schedules`, `SessionListEntry.schedules`, `session/schedule_delete`, `TurnStart.schedule`; `client/mapping.ts` reverse; `protocol.json` regen | S | cross-module | additive, no note |
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
| `/clear` | dropped + notice (Q7) | — |
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
  - T-D6 `/clear` drops + notice; compaction keeps; settings sync keeps (mutation: table on the agent → red).
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

## Execution

## Review
