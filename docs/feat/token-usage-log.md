# feat/token-usage-log — Per-round token usage log

> **Status:** implementation (executor writes the plan, then executes — pre-approved within the bounds below)
> **Branch:** `feat/token-usage-log`
> **Size:** S · **Blast:** contained · **Suited:** DeepSeek plan + exec, Opus review
> **Changelog:** `changelog.d/token-usage-log.added.md`

## Context

Owner 2026-11-16: DeepSeek executor runs have burned ~8B input tokens and we cannot see where. We need, per model round, the token usage (input/prompt, output/completion, cached input when the provider reports it, model id) recorded so a run can be analysed afterwards (which rounds, which tool results, how the context grows). It also measures feat/smart-compaction (next task) before/after.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Pre-approved bounds (orchestrator, night delegation 2026-11-17 — the executor writes the §8 plan here FIRST, citing file:line, then implements it):
- Find where each provider returns usage (packages/providers) and where the agent loop finishes a round (packages/agent); carry the usage you find, do not invent numbers (absent ⇒ omitted, not 0).
- Record per round: round index, model id, input, output, cached input (if reported), and the context size/message count sent. Where: prefer a **non-critical** session-log entry type (unknown-type skip rule, AGENTS §7) or a per-session sidecar `<uid>.usage.jsonl` next to the session log — choose the smaller, cleaner one and justify it. NO critical entry, NO breaking protocol change (an additive display update or none at all), never rendering-only.
- A way to read it: a `tentacle logs`/`sessions`-style subcommand or flag that prints a per-round table + totals for a session (or for the last headless `-p` run), plain text, no colours when piped.
- Tests: usage captured from a fake provider stream; absent usage omitted; totals; the reader's output; the log/sidecar survives reload; unknown entry skipped by an older reader if you chose the log.

### Load-bearing assumption (the one this change stands or falls on)

**A new NON-critical session-log entry type is skipped by every existing reader, leaving the projection untouched — so recording it needs no `PROTOCOL_VERSION` bump.** Proven empirically (`.tentacle/tmp/token-usage-log/unknown-entry.ts`, output in Execution): an entry `{type:"usage", seq:3, …}` appended after a `message` is (a) skipped by `parseLogFile` (`skipped=1`, projection still `[{role:"user",content:"hi"}]`, `lastId` = the usage entry so an append still continues it) and (b) dropped by `applyLogRead` (client reader, chain intact, `outcome:"cold"`, projection unchanged). Cited source: `packages/protocol/src/session-log.ts:11-22` (skip rule), `LOG_ENTRY_CRITICAL` at `:296`, `packages/daemon/src/session-log-file.ts:100`, `packages/client/src/session-log-reader.ts:77`.

### Preconditions (verified)

- The daemon's log is where a per-round fact can live: `SessionLog` (`packages/daemon/src/session-log.ts:60`) is the daemon's own typed log, and the laptop's copy IS those entries appended to `<uid>.jsonl` (`LogSessionStore.writeLocked` → `appendLines`, `packages/daemon/src/session-log-store.ts:754`); a `serve` daemon writes the same entries to its own store. So ONE entry per round reaches both copies with no new file, no new writer, no lock work. → **Chosen: the log, not a `<uid>.usage.jsonl` sidecar** (smaller: zero new I/O paths, zero new lock/queue/atomic-rewrite logic, and an older build already ignores it; a sidecar would need its own durability, its own removal on `session/delete`, and its own reload story).
- Where a round finishes, agent-side: `packages/agent/src/agent.ts:1413-1419` (`done` with `usage` → `anchorContext`/`addSpend`/`yield usage`) and `:1735` (the forced final report). The loop also knows the round index (`iteration`, `:1344`) and how many messages it sent (`const sent = messages.length`, `:1393`).
- The daemon sees that event: `packages/daemon/src/hosted-session.ts:2996` `drive()` iterates `AgentEvent`s and already branches on event types before `eventToUpdate` (`tool_phase`, `:3050`). The turn id is `drive`'s own `turnId`; the model id is `this.mainModelId()` (`:1721`), `undefined` over the pod tunnel by design.
- Providers drop cached-token counts today: Anthropic folds `cache_read_input_tokens`/`cache_creation_input_tokens` into `promptTokens` and throws the cache split away (`packages/providers/src/anthropic-provider.ts:212-223`); OpenAI-compatible ignores `prompt_tokens_details` (`openai-provider.ts:108`). `Usage` (`packages/core/src/model.ts:132`) has no field for it.
- A reader exists to hang a printer on: `tentacle logs` already resolves the laptop store, this project's `serve` store and the other projects, then a uid (`packages/cli/src/logs-cmd.ts:270` `resolve`), and its flags live in one spec (`packages/cli/src/flags.ts:241`).

### Design

**1. One new non-critical log entry type, `usage`.** `LogUsageEntrySchema` (`packages/protocol/src/session-log.ts`, beside `LogSubagentEndEntrySchema`): envelope + `skippable()`, and the round's measured facts:

| field | meaning |
|---|---|
| `turnId` | optional — the turn it belongs to |
| `round` | optional int — 0-based round index inside the turn |
| `final` | optional `true` — the ONE forced report after a spent step budget (no `round`) |
| `model` | optional — the model id, only when this daemon can know it (`undefined` over the pod tunnel) |
| `promptTokens`, `completionTokens` | required, as the provider measured them |
| `cachedPromptTokens` | optional — read-from-cache input, when the provider reports it |
| `messages` | required — how many messages the request carried (the context it sent) |

Added to `KnownLogEntrySchema`'s union and to `LOG_ENTRY_CRITICAL` as `false`. Absent values are **omitted**, never 0 (an unmeasured prompt is not a zero prompt). No `PROTOCOL_VERSION` bump (non-critical ⇒ skippable, proven above); `packages/protocol/schema/protocol.json` is regenerated (`bun run schema:export`).

**2. Providers carry the cache split.** `Usage.cachedPromptTokens?: number` (`core`). Anthropic: the `message_start` cache-read count (the cache *creation* count is a write, not a hit, so it stays inside `promptTokens` only). OpenAI-compatible: `usage.prompt_tokens_details.cached_tokens`. Both optional, both omitted when the server says nothing.

**3. The agent enriches its `usage` event** with what the daemon cannot see: `round` (or `"final"`), and `messages` (the `sent` count; the final report sends `finalMessages.length`). `usage` (the provider's numbers) is unchanged, so every existing consumer (`daemon/mapping.ts:286`, `cli/render.ts`, `tui/src/state.ts`) is untouched.

**4. The daemon logs one entry per measured round.** `SessionLog.usage(body)` pushes it; `hosted-session.ts` `drive()` calls it in the same stretch it emits the `agent_usage` update, with `turnId`, `this.mainModelId()`. No `persist()` of its own: the entry rides the next committed boundary's capture like every other log entry (a round always ends at a commit or at the turn's end). A round with no `usage` produces **no entry** at all.

**5. Read it back: `tentacle logs [<uid>] --usage`.** A new pure module `packages/cli/src/usage-report.ts`: `usageRows(entries)` (per-round rows + totals: rounds, input, output, cached, and the context growth = each row's `messages`/`promptTokens`) and `formatUsage(rows)` — plain text, no colour, aligned columns, one `total` line. `logs-cmd.ts` prints it instead of the event stream when `--usage` is given (`--usage --json` → one JSON object with `rows` + `totals`); with no uid it is the newest session of the project, i.e. the last `-p` run. A session with no `usage` entries says so and exits 0.

### Files to change (dependency order)

1. `packages/core/src/model.ts` — `Usage.cachedPromptTokens?`.
2. `packages/providers/src/anthropic-provider.ts`, `packages/providers/src/openai-provider.ts` — carry it.
3. `packages/protocol/src/session-log.ts` — `LogUsageEntrySchema`, union, `LOG_ENTRY_CRITICAL.usage = false`; `packages/protocol/schema/protocol.json` regenerated; `packages/protocol/test/session-log.test.ts` (the full-table `toEqual` at `:133`).
4. `packages/agent/src/agent.ts` — `AgentEvent`'s usage variant gains `round` + `messages`; both yields set them.
5. `packages/daemon/src/session-log.ts` (`usage()`), `packages/daemon/src/hosted-session.ts` (`drive()` branch).
6. `packages/cli/src/usage-report.ts` (new, pure), `packages/cli/src/logs-cmd.ts` (`--usage`), `packages/cli/src/flags.ts` (the flag + `USAGE.logs`).
7. Tests (below), `changelog.d/token-usage-log.added.md`.

### Failure modes

- **Provider reports no usage** → no event → no entry, and `--usage` says "no usage recorded" (never a 0/0 row).
- **Cached tokens not reported** → field omitted; totals show `—` for that row, never 0.
- **Pod tunnel** → `model` and `cachedPromptTokens` omitted (the laptop's model id must not leak, AGENTS §7); a pod daemon persists nothing anyway.
- **Older build reads a newer laptop log** → the entry is non-critical ⇒ skipped, projection intact (proven).
- **Newer build reads an older log** → no entries; clear message, exit 0.
- **Compaction / `context_reset` with `keepSuperseded` off** → the superseded segment (and its usage rows) is dropped by the rewrite; totals cover the current segment. Stated in `--usage`'s header line ("current segment") — deliberate, see Review/debt.
- **Torn/unknown lines** → the store's append/rewrite rules are unchanged: usage is a KNOWN, appended (never carried-in) type.
- **A long turn** → bounded by `maxIterations` (+1 final) entries per turn.

### Tests

- `packages/protocol/test/session-log.test.ts` — the type parses; `LOG_ENTRY_CRITICAL.usage === false`; the full table matches (updated).
- `packages/protocol/test/session-log.test.ts` (or the reader's test) — a `usage` entry between two messages leaves the folded projection equal (the skip contract at its strongest).
- `packages/providers/test/anthropic-provider.test.ts` — cache read ⇒ `cachedPromptTokens`; no cache fields ⇒ omitted.
- `packages/providers/test/openai-provider.test.ts` — `prompt_tokens_details.cached_tokens` ⇒ carried; absent ⇒ omitted.
- `packages/agent/test/*` (the file owning the usage event) — `round`/`messages` on each round; `"final"` on the forced report; no usage from the provider ⇒ no `usage` event.
- `packages/daemon/test/session-capabilities-log.test.ts`-style rig (new `token-usage-log.test.ts`) — one entry per round with round/model/tokens/messages; absent usage ⇒ none; the durable file parses and still holds them after a reload.
- `packages/cli/test/usage-report.test.ts` (new) — rows + totals math, omitted-vs-zero, formatting.

### Validation

`bunx tsc --noEmit`, `bun run lint`, `bun test`; `bun run schema:export` diff for `protocol.json`. Red-before-green shown for the protocol/daemon/cli tests, and the plan's targets mutation-checked (results pasted in Execution).

### Notes / debt

- Usage rows are turn-agnostic totals per segment: a superseded segment's rows are gone with it (`keepSuperseded` on keeps them).
- Sub-agents' rounds are not logged as their own rows (a child's spend already rides `subagent_usage`), only the main loop's rounds — the analysis target (context growth of the main conversation).

*— claude (Anthropic) via Claude Code 2.1.323 — the harness does not expose the exact model id (executor), 2026-11-17*

## Execution

As built, in dependency order (the Implementation plan above was approved in
bounds and not rewritten).

1. **`core`/`providers`.** `Usage.cachedPromptTokens?: number`
   (`packages/core/src/model.ts`); `anthropic-provider.ts` sets it from
   `message_start.usage.cache_read_input_tokens` *only when `input_tokens` is
   present* (the same guard the prompt total uses), so the cache **creation**
   count stays inside `promptTokens` only; `openai-provider.ts` carries
   `usage.prompt_tokens_details.cached_tokens`. Both spread the field
   conditionally — absent stays absent.
2. **`protocol`.** `LogUsageEntrySchema` (envelope + `skippable()`, `turnId?`,
   `round?`, `final?: true`, `model?` with `USAGE_MODEL_ID_MAX_CHARS = 200`,
   `promptTokens`, `completionTokens`, `cachedPromptTokens?`, `messages?`), in the
   `KnownLogEntrySchema` union and `LOG_ENTRY_CRITICAL.usage = false`.
   `packages/protocol/schema/protocol.json` regenerated by `bun run
   schema:export` (68 insertions). No `protocol.d/` note: non-critical ⇒
   skippable, proven below.
3. **`agent`.** `AgentEvent`'s usage variant gained optional `round`, `final`,
   `messages`; the per-round yield sets `round: iteration, messages: sent`
   (`packages/agent/src/agent.ts:1433`), the forced final report sets
   `final: true, messages: finalMessages.length` (`:1752`).
4. **`daemon`.** `UsageBody` + `SessionLog.usage()`; `hosted-session.ts` `drive()`
   logs one entry per usage event (`:3058`), `turnId`, `this.mainModelId()` when
   defined, cache and message count when defined. No `persist()` of its own.
5. **`cli`.** `packages/cli/src/usage-report.ts` (new, pure): `usageRows`,
   `usageTotals`, `usageReport`, `formatUsage`; `logs-cmd.ts` `--usage`
   (placed after `--summary`, before `-f`; `--json` → one object), `flags.ts`
   `usage: {}` + `USAGE.logs`, `main.ts` forwards the bool.
6. **Tests** (`protocol`, `daemon/session-log-file`, `daemon/token-usage-log`
   new, `agent/token-usage-event` new, both providers, `cli/usage-report` new,
   `cli/logs-cmd`), then the mutation checks, `changelog.d/token-usage-log.added.md`,
   the gate.

### Drift from the Implementation (and why)

- **`messages` is OPTIONAL in the schema, not required.** The plan's table said
  required. `AgentEvent`'s `messages` has to be optional (an agent built
  elsewhere — every test rig — yields the provider's numbers alone, and making
  the event field required would break those constructors), so the daemon
  cannot guarantee it; a required schema field would have forced a fake `0`
  into the log, which is exactly the "absent is not 0" rule this task exists to
  keep. Same reasoning for `model` (undefined over the pod tunnel) — already
  optional in the plan.
- **`--usage` also refuses `--connect`.** The plan only said a summary is a
  file's fact; the shared branch in `logs-cmd.ts:861` covers both, with its own
  pointer (`--usage reads a session's log file on THIS laptop; for a serve
  session, run it on that host`).
- **`formatUsage`'s total row renders `—` in the model/msgs columns**
  (the plan did not specify). The first version used `""` there; the test caught
  that an empty cell collapses the two-space separator and misaligns the whole
  row under its columns (`total            —    260      16      90`). Fixed in
  the module, not the test.
- **The agent test drives a turn through `new Session(agent, id)` +
  `session.send("go")`**, not `agent.run` (which takes `readonly ChatMessage[]`);
  that is how the existing tests collect `AgentEvent`s.

### Load-bearing assumption — recorded output (not re-run)

`.tentacle/tmp/token-usage-log/unknown-entry.ts` (output as recorded in
Implementation, above): a `{type:"usage"}` entry appended after a `message` is
(a) skipped by `parseLogFile` — `skipped=1`, projection still
`[{role:"user",content:"hi"}]`, `lastId` the usage entry, so an append still
continues the chain — and (b) dropped by `applyLogRead` with the chain intact
(`outcome:"cold"`, projection unchanged). Both readers are `KNOWN`, non-critical
and fold to **nothing**; the daemon-side test
(`packages/daemon/test/session-log-file.test.ts`) now pins that permanently.

### Mutation checks (applied temporarily, narrow file run, reverted; §9)

| mutation | result |
|---|---|
| daemon `drive()`'s `if (event.type === "usage")` block deleted | `daemon/test/token-usage-log.test.ts`: **3 of 4 fail** (only the "no entry when unmeasured" one passes — it asserts an absence); green after revert |
| `LogUsageEntrySchema`'s `skippable()` → `critical()`, table `usage: true` | protocol + `session-log-file` + `logs-cmd`: **5 fail** (`line 4 is a malformed usage entry`, `LOG_ENTRY_CRITICAL.usage` mismatch); green after revert |
| `anthropic-provider`: `cachedPromptTokens = start.cache_read_input_tokens ?? 0` | `anthropic-provider.test.ts`: **4 fail** (the `toEqual`s now carry a spurious `cachedPromptTokens: 0`, plus the `"cachedPromptTokens" in usage` assertions); green after revert |
| `openai-provider`: `cachedPromptTokens: … ?? 0` | `openai-provider.test.ts`: **2 fail**; green after revert |
| `agent`: both yields reduced to `{ type: "usage", usage }` (no `round`/`messages`) | `agent/test/token-usage-event.test.ts`: **2 of 3 fail** (`round` map is `[undefined, undefined]`, `last.messages` undefined); green after revert |

Test non-vacuity was also observed directly on the real thing: the pre-existing
anthropic `toEqual` at `:627` went red as soon as the provider started carrying
the field (before it was updated deliberately) — proof the field really travels.

### Per-slice status

| slice | status |
|---|---|
| core/provider `cachedPromptTokens` | **DONE** (tests + mutation) |
| protocol `usage` entry, schema export, critical table | **DONE** |
| agent event enrichment (`round`/`final`/`messages`) | **DONE** |
| daemon `drive()` → log entry | **DONE** (exactly-once, durable after reload) |
| cli `--usage` (table, `--json`, refusals) | **DONE** |
| changelog fragment | **DONE** |
| `TODO.md` | untouched (not this task's) |

### Gate

`bunx tsc --noEmit` → clean (also `tsc -p apps/mobile`, `tsc -p apps/relay`);
`bun run lint` → `Checked 1850 files … No fixes applied` (clean baseline);
`bun test` → **13454 pass, 5 skip, 0 fail** across 959 files. The 5 skips are the
documented opt-in ones (docker ×2, live-k8s ×2, the real-socket keepalive slow
test) — no new skip, no new failure.

*— Claude via Claude Code 2.1.323 — the harness does not expose the exact model id (executor), 2026-11-17*

## Review

**Verdict: REQUEST-CHANGES** (one HIGH).

### Findings

1. **HIGH — a `null` cache count from the server permanently breaks the session's log read (laptop persistence, and the `serve` reload).** `packages/providers/src/openai-provider.ts:279` tests `cached_tokens !== undefined`, so `prompt_tokens_details: { cached_tokens: null }` (the shape LiteLLM-style proxies send) yields `cachedPromptTokens: null`. The same applies to `anthropic-provider.ts:225` with `cache_read_input_tokens: null`, which the Anthropic API types as nullable; the pre-existing `?? 0` on `:222` handled null, but the new guard does not. `hosted-session.ts:3058` writes it into the log without validating it, and `LogUsageEntrySchema` rejects `null` (`.optional()` only). A malformed KNOWN entry is fatal, not skipped: `client/session-log-reader.ts:263-265` returns `malformed usage entry N`, `remote-client.ts:2585` retries cold, gets the same error, and after `LOG_ATTEMPTS` throws `session/log: the daemon's log was refused`. So every later save of that session fails until the segment is rebased. A `serve` daemon's own file hits the same refusal at `session-log-file.ts:259-261` on reload. Repro output (`.tentacle/tmp/token-usage-log/null-cache.ts`, worktree imports): `usage: {"promptTokens":10,"completionTokens":5,"cachedPromptTokens":null}` → `Expected number, received null` at `cachedPromptTokens`. This contradicts the plan's claim that the entry is purely additive. Fix: accept only non-negative integers at both providers (`typeof x === "number"`). Also make `SessionLog.usage` validate the entry against `LogUsageEntrySchema` and drop any invalid field or entry instead of pushing it, so a provider can never write a log entry that poisons the log. A `model` id that is empty or over 200 chars has the same failure class. Add a test for the `null` case at both providers, plus a daemon-side test.

### Gate / evidence

- 8 touched test files: **109 pass, 0 fail**. `bun run lint`: clean (1850 files). `bun run typecheck`: clean, all three tsconfigs. I did not re-run the full suite (the executor reports 13454 pass / 5 opt-in skips).
- Mutation (mine): removed the `model` spread in `hosted-session.ts` `drive()`. `daemon/test/token-usage-log.test.ts` went **1 fail / 3 pass**. Reverted; `git status` is clean.

### Premises

- The skip rule for an unknown non-critical entry, `LOG_ENTRY_CRITICAL.usage=false`, the `drive()` site and the provider sites: **TRUE**. An older reader skips the entry: TRUE.
- Implied premise: the `usage` entry is always well-formed. **FALSE**: see finding 1.

### Attacks tried

- (a) Null or absent provider fields → finding 1.
- (b) `tentacle logs` stream and `--summary` with a usage entry present: `log-events.ts` `default:` cases drop it. Nothing found.
- (c) A client reader that switches on update types (`mobile/transcript.ts`, `tui/state.ts`): the usage entry is log-only and does not reach them. Nothing found.
- (d) No `PROTOCOL_VERSION` bump: correct for a non-critical type.

### What holds

The non-critical type, the absent-not-0 rule for the happy path, the pure `usage-report.ts`, and the refusal of `--connect`. The tests are non-vacuous (the executor's mutations plus mine).

### Executor behaviour

Disciplined: plan cited, drift recorded honestly. One gap: its proof script imported `@tentacle/*` from `.tentacle/tmp`, which resolves to **main's** packages, not the worktree. That was right for the "older reader" claim, but it means nothing it ran exercised the new schema. Reviewer and executor are both Claude-family; only the context is fresh.

*— claude-opus-5-5, 2026-11-17*
