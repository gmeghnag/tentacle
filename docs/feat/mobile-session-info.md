# feat/mobile-session-info — "Session info" on the iPhone: model, MCP servers, skills, context

> **Status:** implementation (awaiting owner approval; Owner questions below are open)
> **Branch:** `feat/mobile-session-info`
> **Size:** M (4 slices, each S) · **Blast:** cross-module (one OPTIONAL additive `initialize` field if Owner Q1 = yes, one client getter, the rest is `apps/mobile`; no persistence, no §7 invariant moved) · **Suited:** strong model executes slice 1–2 (protocol/client), any model slices 3–4; fresh-context Review + Fable visual review of the screenshots (the mobile-ui-polish quality bar)
> **Changelog:** `changelog.d/mobile-session-info.added.md`

## Context

*— claude-opus-5-5, 2026-11-15*

**Owner request (2026-11-15).** In the iPhone app's session view, show (1) the
**model** the session uses (name; provider/profile if cheap), (2) the session's
**MCP servers** (name, connected/failed, tool count) and **skills** (name + one
line), and "etc." — the few other session facts worth having on the phone.

**What a person sees today.** The terminal already answers these questions:
`/mcp` (`packages/tui/src/mcp-panel.ts:36-80`, one row per server, glyph + state +
`N tools`, error on expand), `/skills` (`packages/tui/src/skills-panel.ts`), and
the status bar's ctx meter (`packages/tui/src/status-view.ts:24`). The phone has
none of it: the chat header shows a title and a status word only
(`apps/mobile/src/chat-header.ts:23-41`), and the glass "…" menu offers just the
two copy actions (`apps/mobile/src/session-menu.ts:10`, `SessionMenuId =
"copy-last" | "copy-all"`). The `initialize` result the app receives (with the
daemon's model) is stored and never read (`apps/mobile/src/connection.ts:345-349`).

**Constraints.** The approved mockup language and the owner's binding quality
bar from `docs/feat/mobile-ui-polish.md:575-579` (native iOS feel, grouped
insets, glass buttons, sheets, light + dark, designed empty/loading/error/offline
states, one token module). Owner decision 2 of mobile-ui-polish (`:568`) kept
*computer-side actions* out of the "…" menu; this task adds a **read** (plus,
per Owner Q3, the already-shared auto-accept switch), not an action on the
computer. AGENTS §7: logic in pure modules; one session path (`RemoteClient` /
`RemoteSession`); protocol strip schemas, additive.

**Repro (capability missing), 2026-11-15, on `feat/mobile-session-info` = `main` b97ff97b:**

```
$ rg -n 'mcpStatus|\.skills\(|\.context\(|agentInfo|sessionList' apps/mobile -g '!node_modules/**'
apps/mobile/e2e/seed.ts:349:    const page = await live.sessionList({ limit: 50 });
apps/mobile/App.tsx:438:            const page = await link.client.sessionList({ limit: 1 });
apps/mobile/App.tsx:784:        return link.client.sessionList(
(… tests only below …)
```

No `mcpStatus`, `skills()`, `context()` or `agentInfo` read anywhere in the app:
the data is on the wire, the phone never asks for or shows it. `session-menu.ts:10`
has only `"copy-last" | "copy-all"`.

## Implementation

*— claude-opus-5-5, 2026-11-15*

### Load-bearing assumption

**Everything the sheet needs is already served to a paired phone over the ONE
client stack — no new wire method, no new update.** Proof:

| Fact | Source on the wire | Client seam the phone already has |
|---|---|---|
| Model name + its context window | `initialize` → `agentInfo.model`, `agentInfo.contextWindow` (`packages/protocol/src/session.ts:269-286`); `serve` fills them from its own config (`packages/cli/src/serve.ts:511`, sent at `packages/daemon/src/connection.ts:683-692`) | `link.init` (`apps/mobile/src/connection.ts:100,345`); per-handshake copy kept privately in `RemoteClient.daemonImages` (`packages/client/src/remote-client.ts:898,2570-2578`) |
| MCP servers, state, tools, error | `mcp/status` (`packages/protocol/src/mcp.ts:27-53`), daemon-wide probe | `RemoteClient.mcpStatus()` (`remote-client.ts:965-972`) |
| Skills (name, description, scope, user/model) + problems | `session/skills` (`packages/protocol/src/skills.ts:22-74`) | `RemoteSession.skills()` (`packages/client/src/remote-session.ts:902-905`) |
| Context used (exact or estimate) | `session/context` (`session.ts:1103-1126`) | `RemoteSession.context()` (`remote-session.ts:914-928`) |
| cwd, attached clients, background jobs, running | `session/list` entry (`session.ts:1258-1277`) | `RemoteClient.sessionList()` (`remote-client.ts:1069`, already used by the app, `App.tsx:784`) |
| Auto-accept (shared) | `OpenResult.autoAccept` + `session/set_auto_accept` + `auto_accept` update (`session.ts` OpenResult/SetAutoAccept, `updates.ts:513`) | `SessionHandle.autoAccept` (`apps/mobile/src/session-controller.ts:49-54`), already driving the permission sheet's switch (`permission-sheet.ts:124-139`) |

The daemon dispatches the three pulls with **no principal gate** — a `device`
connection may call them (`packages/daemon/src/connection.ts:401-406`; the only
device-specific gates are push, `:459,471`). The phone's session handle IS a
`RemoteSession` (cast, `apps/mobile/App.tsx:210-219`), so `skills()`/`context()`
exist on it at runtime; only the `SendableHandle` type must name them.

### Preconditions

- **One session path (§7).** All pulls go through `link.client` / the open
  `RemoteSession`; no frame is built in the app (`App.tsx:887-891` is the
  pattern: "the session's own client methods — no frame built here").
- **Strip schemas (§7 forward-compat).** A new optional field on
  `agentInfo` is dropped by an older client and absent from an older daemon —
  not breaking, so **no `protocol.d/` note**, no `PROTOCOL_VERSION` move.
- **`serve` is the only daemon a phone reaches** (relay / `/e2e` route into
  `startDaemon`), and it is trusted (§7 persistence bullet). Strings still pass a
  display sanitizer (bidi/zero-width), mirroring `oneLine`
  (`packages/tui/src/commands.ts:56-64`): the schemas only reject control chars
  (`mcp.ts:16`, `text-line.ts`).
- **`attached` counts this phone.** `HostedSession.summary` reports
  `attachments.size` (`packages/daemon/src/hosted-session.ts:1631`), so while the
  phone is attached, *others* = `attached − 1`.
- **cwd of a live `serve` session = the daemon's default cwd**
  (`session-host.ts:623-625` passes `this.opts.defaultCwd`) — still the right
  "project" to show.
- **`RemoteSession.skills()`/`context()` fall back to a *fresh* session when the
  handle has no id** (`remote-session.ts:903-904,927`). The phone attaches with
  `attach` and never creates, so on a failed/archived open these would describe
  a session that does not exist. The view MUST NOT call them unless the screen's
  phase is `open` (failure mode F4).
- **`mcp/status` is daemon-wide**, not per session (`connection.ts:401-402`): the
  sheet says "on <computer>", not "this session's".
- `agentInfo.model` is `config.model` — the model **id** (`resolve.ts:96,621`),
  e.g. `claude-sonnet-4-5`, `qwen3-27b`. The provider is
  `ResolvedConfig.provider: "openai" | "anthropic"` (`resolve.ts:94`), not on the
  wire today.

### Design

#### What the sheet shows (and why each fact earns its row)

Opened from the glass "…" in the chat header → a new first action **Session
info** (`info.circle`) in the existing `ActionSheet`, above the copy actions;
it is offered always (the copy actions keep their "only when there is text"
rule; "Nothing to copy yet" becomes a footnote only when there are no copy
actions). It opens a native `pageSheet` built from the shared `Sheet`
(grabber, 22 pt title **Session info**, subtitle = the session title), then
grouped sections (`SectionHeader` + 26 pt `GroupedCard` + 44 pt `Row`), exactly
the Settings screen's grammar (`mobile-ui-polish.md:1288-1291`). Pull-to-refresh
re-runs every pull.

1. **MODEL**
   - *Model* — `claude-sonnet-4-5` (mono 15, `sec` trailing value, tail-truncated).
     Why: the first question when an answer surprises you; `serve` may run a
     different model than the laptop's TUI config.
   - *API* — "Anthropic" / "OpenAI-compatible" — **only if Owner Q1 = yes**
     (slice 1). Why: tells a local Qwen apart from a hosted model at a glance.
   - *Context* — `42 % · 84k of 200k` with a 4 pt capsule meter under the row
     (accent; `attention` ≥ 80 %, the TUI's warn zone); `≈` prefix when
     `exact: false`. Why: the single best predictor of "it's about to compact /
     forget"; it is what the TUI's status bar shows. Window absent (older daemon)
     → `84k tokens`, no meter.
2. **SESSION**
   - *Project* — last two path components of `cwd`, middle-truncated
     (`…/tentacle/apps`), full path in the accessibility label. Why: which repo
     the agent is touching — the list shows it per computer, not per session.
   - *Devices* — "Only this phone" / "This phone + 1 other" (from `attached − 1`).
     Why: whether a terminal is also on it (it may answer an ask first). Names
     are not on the wire; not added (see Notes).
   - *Background* — "2 jobs running" (list `jobs`), row hidden at 0/absent.
     Why: explains a session that keeps working while idle.
   - *Auto-accept* — native `Switch` bound to `SessionHandle.autoAccept`
     (**Owner Q3**); hidden when the handle has none (older daemon). Why: it is
     the session's most consequential setting and today it is only reachable
     inside a permission prompt.
3. **MCP SERVERS · on <computer>** — one row per server, daemon order (as
   `/mcp`): `StatusDot` (connected → `online`, connecting → `offline` pulsing,
   unresponsive → `attention`, closed → `offline`, failed → `attention` + an
   `exclamationmark.triangle` glyph — `StatusTone` has no error tone,
   `apps/mobile/src/ui/StatusDot.tsx:10`; adding one is presentation, not
   needed), name
   (mono 15), trailing `12 tools` (connected) or the state word. A non-connected
   server shows its `error` as a two-line `sec` subtitle; tap expands to the
   full error. Tap on a connected server expands the tool names (comma list,
   `N more` from `moreTools`). Section footer: "3 of 4 connected".
4. **SKILLS** — one row per skill (the precedence order of `skills`): name
   (`/name` when `user: true`, else bare), one-line description (1-line clamp,
   tap → full), trailing chip `project`/`user`; a skill neither the user nor the
   model can use now renders `ter` with "off". Cap 100 rows + "and N more"
   (wire cap 512, `skills.ts:19`). Footer when `problems.length + moreProblems >
   0`: "2 skills skipped — open /skills on the computer for details". `location`
   (a path) is not shown.
5. Footer caption: `tentacle <agentInfo.version> · <computer name>` — tells
   "too old to report X" apart at a glance.

**Header** (**Owner Q2**): the compact header's subtitle becomes `● Idle ·
claude-sonnet-4-5` — the status first (unchanged tone/dot), then ` · model` in
`sec`, the model part tail-truncated first so the status word never clips;
no model known → status only (today's look).

#### States (every section independently)

`loading` (a `ter` 15 pt shimmer row "Checking…"/"Counting…") · `ready` ·
`empty` · `error` (row "Couldn't load · Retry" in `attention`) · `unsupported`
(MethodNotFound: "Needs a newer tentacle on <computer>") · `offline` (link down:
one `Banner` `wifi.slash` "Offline — showing nothing until reconnected" at the
top; the sections show their last value dimmed if they have one) · `not-open`
(Skills/Context only, session not attached — archived, failed: "Open the session
to see its skills/context"). Empty copy: MCP "No MCP servers on <computer>" +
footnote "Add them under `mcpServers` in its config"; Skills "No skills" +
footnote "Skills live in `.agents/skills/<name>/SKILL.md`". Light + dark from
the palette only.

#### Code shape (AGENTS §7: logic pure, components render)

- `src/session-info.ts` (**pure**, React-free): `sessionInfoView(facts) →
  SessionInfoView` — the sections, their rows (label, value, tone, subtitle,
  expandable text), every state above, the context percent/rounding
  (`84k`, `1.2M`), the meter tone, the `attached − 1` wording, the cwd
  shortening, the caps/"N more", the display sanitizer, the header subtitle
  `headerModel(status, model)`.
- `src/session-info-controller.ts` (**pure**, deps injected): on `open()`
  starts the four pulls **in parallel** (`Promise.allSettled`-style, each
  settling its own section), a generation counter drops results of an earlier
  open / after `close()`, `refresh()`, and one auto-refresh on link `up` while
  open. Classifies errors: `RpcError` MethodNotFound → `unsupported`; "not
  connected" → `offline`; else `error`.
- `src/session-menu.ts`: + `"info"` id (always first).
- `src/chat-header.ts`: unchanged status logic; the model suffix lives in
  `session-info.ts` `headerModel` (one place for model display).
- `src/screens/SessionInfoSheet.tsx` (**render only**) + the `…` wiring in
  `SessionScreen.tsx`; `App.tsx` passes an `info` port into
  `createSessionScreen` (`link.client.daemonInfo()`, `mcpStatus()`,
  `sessionList()`, and the open handle's `skills()`/`context()`/`autoAccept`).

### Files

Dependency order. Slice 1 exists only if Owner Q1 = yes.

**Slice 1 — protocol + daemon (S, optional, Q1):**
1. `packages/protocol/src/session.ts` — `agentInfo.provider:
   z.enum(["anthropic","openai"]).optional().catch(undefined)` (fail-soft: a
   newer daemon's value is dropped, never rejects the handshake — the
   `MessageNote` precedent, `session.ts:84`).
2. `packages/daemon/src/session-host.ts:313,445` — `modelInfo.provider?`;
   `packages/daemon/src/connection.ts:687-691` — send it.
3. `packages/cli/src/serve.ts:511` — `provider: config.provider`.
4. `bun run protocol:bump` is the orchestrator's (regenerates `protocol.json`;
   no note: additive).

**Slice 2 — client (S):**
5. `packages/client/src/remote-client.ts` — public `daemonInfo(): { version?,
   model?, contextWindow?, provider? } | undefined`, re-read on **every**
   handshake next to `daemonImages` (`:2570-2578`), so a `serve` restarted with
   another model is right after the reconnect (the app's `link.init` is the
   first handshake only).

**Slice 3 — app pure (S):**
6. `apps/mobile/src/session-info.ts` (new) + `apps/mobile/test/session-info.test.ts`.
7. `apps/mobile/src/session-info-controller.ts` (new) +
   `apps/mobile/test/session-info-controller.test.ts`.
8. `apps/mobile/src/session-menu.ts` (+ `"info"`) + its test.
9. `apps/mobile/src/session-screen-controller.ts` — `SendableHandle` gains
   optional `skills?()` / `context?()` (what `RemoteSession` already has);
   `SessionScreenDeps.info?` port; exposes the info controller and the header
   model.

**Slice 4 — app UI + e2e (S/M):**
10. `apps/mobile/src/screens/SessionInfoSheet.tsx` (new, render only; testIDs
    `session-info-sheet`, `session-info-model`, `session-info-context`,
    `session-info-mcp-<name>`, `session-info-skill-<name>`,
    `session-info-autoaccept`, `session-info-retry-<section>`).
11. `apps/mobile/src/screens/SessionScreen.tsx` — menu action, header subtitle.
12. `apps/mobile/App.tsx:879-892` — pass the `info` port.
13. `apps/mobile/src/ui/Icon.tsx` — `info.circle`, `server.rack`,
    `sparkles` (SF Symbols) if missing.
14. `apps/mobile/e2e/run.ts` `harnessConfigText()` — add `mcpServers`: one
    working stdio server (`bun packages/mcp/test/fixtures/strict-legacy-stdio-server.ts`;
    the executor confirms it lists ≥ 1 tool) + one failing (`command:
    "/nonexistent-tentacle-e2e"`); a user skill at
    `<runDir>/config/skills/e2e-demo/SKILL.md` (`<configDir>/skills` is a scan
    root, `packages/config/src/skills-scan.ts:42-45`).
15. `apps/mobile/e2e/flows/25-session-info.yaml` (new) + `_shot.yaml` calls.
16. `changelog.d/mobile-session-info.added.md`.

### Failure modes

| # | Case | Convergence |
|---|---|---|
| F1 | Link down when the sheet opens / drops mid-pull | Pulls reject "not connected" (`remote-client.ts:966-968`) → `offline` banner, last values dimmed; link `up` while open → one auto-refresh. Never a spinner forever. |
| F2 | Older daemon: `mcp/status` / `session/skills` / `session/context` → MethodNotFound | That section `unsupported`, the others unaffected. |
| F3 | `mcp/status` slow (an unresponsive server waits its ping timeout) | Only the MCP section spins; it is a watched request (liveness close, `remote-client.ts:2585-2592`), so it ends as `error`, not hang. |
| F4 | Session not attached (archived browse, failed open) | Skills/Context `not-open`, **never** called (would describe a fresh session, Preconditions). Model/MCP/Session rows still shown. |
| F5 | Sheet closed or re-opened while pulls are in flight | Generation counter: a stale result is dropped, never painted over a newer one. |
| F6 | `contextWindow` / `model` absent (older daemon) | Context shows tokens only; header shows status only; Model row "Not reported". |
| F7 | `serve` restarted with another model while the app stays on screen | `daemonInfo()` re-read per handshake (slice 2); header/sheet re-read it on link status change. |
| F8 | Session not on the first `session/list` page (> 200 sessions) | Project/Devices/Background rows omitted, not shown as "0". |
| F9 | Huge lists (512 skills, 256 servers × 128 tools) | Row caps + "and N more"; tool names only on expand. |
| F10 | Hostile/odd strings (bidi, zero-width, 1000-char error) | Sanitized + clamped in `session-info.ts`; tested. |
| F11 | Auto-accept flipped on another device while the sheet is open | The switch reads the link's live value (the same `AutoAcceptLink` the permission sheet observes); a failed `set` reverts and shows the error row. Laptop-side gating unchanged (§7). |
| F12 | e2e: the failing MCP server slows `serve` start for every flow | MCP connects off the start path; the executor measures flow 01 time before/after; if it regresses, move the servers to a flow-25-only config restart (`05-start-serve.js` pattern). |

### Tests

Red first (stub returning empty view → fail), then green; mutation proof per §9.

- `session-info.test.ts` (pure): one test per state per section; context
  `84k of 200k → 42 %`, `≈` iff `!exact`, meter tone flips at 80 %; window
  absent → no percent; `attached` 1 → "Only this phone", 3 → "This phone + 2
  others"; cwd shortening; failed server → `error` tone + error subtitle,
  connected → `N tools` = `tools.length + moreTools`; skills `/name` iff
  `user`; caps; sanitizer strips `‮`/`​`; `headerModel` (status
  first, model absent → status only). **Mutations:** drop `moreTools` from the
  count; use `attached` instead of `attached − 1`; invert `exact` → each must
  fail a test.
- `session-info-controller.test.ts` (fake port, deferred promises): parallel —
  a slow MCP pull does not delay Skills; MethodNotFound → `unsupported`; "not
  connected" → `offline` then auto-refresh on `up`; stale generation dropped
  (resolve the first open's MCP after a second open); `not-open` phase never
  calls `skills`/`context` (spy count 0). **Mutation:** remove the generation
  check → the stale test fails; remove the phase gate → spy test fails.
- `session-menu.test.ts`: `info` present with zero rows; copy actions
  unchanged.
- Slice 1: `packages/protocol/test` — `provider` accepted, unknown value
  dropped (handshake still parses); `packages/daemon/test` connection test —
  `serve` modelInfo with provider is reported. Slice 2:
  `packages/client/test` — `daemonInfo()` follows the SECOND handshake
  (fake channel factory, two daemons with different models). **Mutation:**
  read it only on the first handshake → fails.
- e2e `25-session-info.yaml`: open the seeded session → `session-menu` →
  `Session info` → assert model text = the harness mock's model, the working
  server's `tools`, the failing server's `failed`, `/e2e-demo`, context row;
  toggle dark (`appearance.js`); screenshots.
- **Screenshots:** `bun run e2e:mobile --ios 26 --only 25-session-info,06-session-open`
  → light + dark PNGs of the header and the sheet (top + scrolled to Skills)
  under `.tentacle/tmp/mobile-session-info/shots/`; Fable visual review against
  the mockup grammar and the quality bar.
- Gate: `bun run check`, lint baseline clean (§6).

### Notes / debt

- **Device names** under *Devices* ("MacBook Pro") would need the list/open
  to carry attached `clientInfo.host` labels — a wire change, left out; the
  count answers the real question.
- **Per-session model** does not exist on `serve` (one model per daemon); if a
  per-session `/model` lands later, the header reads it from that seam instead
  of `daemonInfo()`.
- **Sub-agent models** (`SubagentRow.model`, `session.ts:570`) are not shown —
  the phone has no sub-agent panel yet.

### Owner questions

1. **Provider on the wire.** Add an optional `agentInfo.provider`
   ("Anthropic" / "OpenAI-compatible") so the sheet shows the API family (slice
   1, additive, no version bump)? Profile name: no — it is a laptop config
   concept, `serve` reports none. *Recommendation:* yes to provider, no to profile.
2. **Model under the title.** Header subtitle `● Idle · claude-sonnet-4-5`
   (status first, model truncated first, hidden when unknown)?
   *Recommendation:* yes.
3. **Auto-accept in Session info.** A live switch bound to the session's
   shared auto-accept (the same link the permission sheet uses), or read-only
   text? *Recommendation:* the switch — it is the most consequential session
   setting and today it is only reachable inside a prompt; gating stays on the
   laptop.
4. **Context meter placement.** Context only in the sheet (pulled on open), or
   also a live meter in the header from `agent_usage`? *Recommendation:* sheet
   only for now — the header stays calm, and the pulled `session/context` is the
   exact figure; a live meter can follow if missed.

## Execution

*— claude-sonnet-4-5-20250929 (executor), 2026-11-15*

**Load-bearing check re-run first — PASSED, and one correction.** Every row of the
table checked out against the code at HEAD `1d3a9c90`, with these findings:

- `mcp/status` (`packages/daemon/src/connection.ts:401-406`) and
  `session/skills` / `session/context` (`:402-404`) dispatch with **no principal
gate** — confirmed; the only `device` gates are push (`:459,471`).
- `RemoteSession.skills()`/`context()` (`remote-session.ts:902,914`) and the
  cast at `App.tsx:210-219` — confirmed.
- **Correction (plan was incomplete, not wrong):** the plan's Owner decisions
  list 5 items; the Implementation/Design/Files sections predate decisions 2
  (model under the title), 4 (context bar in the header) and 5 (rename by
  tapping the title). I implemented the DECISIONS, not the superseded design
  text: no `agentInfo.provider` (decision 1), `shortModel` to the last `/`
  segment (decision 2), `headerContext` bar from `agent_usage` (decision 4), and
  `session/rename` by tapping the title (decision 5). Recorded here as drift.
- **Correction 2:** F11's "a failed `set` reverts" is **wrong against the code**:
  `createAutoAcceptHandle.set` applies locally at once and keeps the value
  pending for a re-send (`auto-accept-link.ts:156-168,193-200`) — a reverted
  switch would disagree with the decision the daemon receives on the next
  attach. Implemented as: report the error, keep the link's value (test
  `a failed set is REPORTED and keeps the person's decision`).

### As built, in dependency order

**Slice 1 — client (the plan's slice 2).** `packages/client/src/remote-client.ts`:
`daemonHandshake` (`:903-909`) re-read on EVERY handshake next to `daemonImages`
(`:2578`), exposed as `daemonInfo()` (`~:1000`). No protocol change: `agentInfo`
already carries `version`/`model`/`contextWindow` (`session.ts:269-286`), so **no
`protocol.d/` note and no `PROTOCOL_VERSION` move**; `protocol.json` unchanged.

**Slice 2 — app pure modules.**
- `apps/mobile/src/session-info.ts` (new): the whole view-model — 4 sections,
every phase per section, `contextMeter`, `tokensText`, `devicesText`
(`attached − 1`), `shortenPath`, `sanitizeDisplay`, `shortModel`, `headerModel`,
`headerContext`.
- `apps/mobile/src/session-info-controller.ts` (new): the four pulls, **each
  painting its own section as it lands** (not one batched `Promise.all`
  assignment — a deferred MCP would have gated all four; caught by the
  parallel test), a generation counter per open/close, one refresh on link `up`,
  and the F4 phase gate.
- `apps/mobile/src/session-rename.ts` (new): `renamePlan` (empty/unchanged =
  no-op, cap, one line), `renameErrorText`, `titleAfterRename`.
- `apps/mobile/src/session-menu.ts`: `"info"` first, always.
- `apps/mobile/src/transcript.ts`: `sessionTokens`/`lastTurnTokens` on `State`,
the `usage` case (the TUI's rule, `state.ts:485-497`), and `lastTurnTokens: null`
on a REPLACED history (the TUI's `forgetContextFill`) — `transcript-parity`
stays green.
- `apps/mobile/src/session-view.ts`: `headerModel` + `headerContext` on the view.
- `apps/mobile/src/session-screen-controller.ts`: `SendableHandle` gained
  `skills?`/`context?`/`rename?`/`onTitle?`; the `info` port dep; `SessionScreenState`
  gained `info` and `renaming`; the actions (`openInfo`/`closeInfo`/`refreshInfo`/
  `setAutoAccept`/`autoAcceptOn`/`beginRename`/`setRenameText`/`submitRename`/
  `cancelRename`), the title watch, and `leave`/`dispose` unsubscribing both.

**Slice 3 — app UI.** `src/screens/SessionInfoSheet.tsx` (render only),
`src/screens/RenameSheet.tsx` (in-app alert: no native alert button is visible to
XCUITest), `screens/SessionScreen.tsx` (menu action, header model + bar, title
tap), `ui/ScreenHeader.tsx` (`onTitlePress`), `App.tsx` (`infoWiring`, built over
`link.client` + the screen's own handle). No new SF Symbols needed —
`xmark`/`wifi.slash`/`exclamationmark.triangle` already existed.

**Slice 4 — e2e.** `apps/mobile/e2e/run.ts`: `harnessConfigText()` now carries one
working stdio MCP server + one `/nonexistent-tentacle-e2e`; `writeHarnessSkill()`
writes `<configDir>/skills/e2e-demo/SKILL.md`; flow `25-session-info` in `FLOWS`
with `INFO_ID`. `e2e/flows/25-session-info.yaml` + `25-session-info.js` (ends on
daemon truth: the rename is read back from `session/list`).

**Drift 3 (added, not in the plan): the context pull runs AT ATTACH.** Owner
decision 4 wants the header's bar live, but a session attached after its turns
has no `agent_usage` to measure from — the bar would stay absent until the next
turn, and a person who never opens the sheet would never see it. The TUI already
solves this (`useSessionLink`'s `askContext` at attach), so
`SessionInfoController.loadContext()` (`session-info-controller.ts`) runs one
`session/context` pull when the attach answers
(`session-screen-controller.ts`'s `attach`), gated on `phase === "open"` (F4)
and on the same generation counter (F5). The sheet's own pull is a separate,
fresh one — never reused, since a turn may have outdated it.

### Tests (red → green, then mutation-proved)

New files: `session-info.test.ts` (37), `session-info-controller.test.ts` (17),
`session-info-header.test.ts` (10), `session-rename.test.ts` (9),
`session-view-header.test.ts` (8), `session-screen-info.test.ts` (10),
`packages/client/test/daemon-info.test.ts` (4). **Red was shown** for the fold's
`usage` case and for every new module (import/export failure first, then
the property): `session-info-header.test.ts` failed with "Export named
'headerContext' not found", `headerContext`/`shortModel` did not exist, and
`usage` was the fold's silent default branch — the fold test failed until the case
was added.

**Mutations (each reverted, restored file re-tested green):**

| # | Mutation | Killed by |
|---|---|---|
| 1 | `count = tools.length` (drop `moreTools`) | `the MCP section > one row per server…` (1 fail) |
| 2 | `others = attached` (no `− 1`) | `devicesText > alone, one other…` + the SESSION section (2 fail) |
| 3 | invert `exact` for `≈` | 5 tests (contextMeter ×3, MODEL section, live-bar) |
| 4 | remove the generation check | `the first open's MCP result… is dropped` + `a result arriving after close()` (2 fail) |
| 5 | remove the phase gate (`port.session()` unconditionally) | `\`skills\`/\`context\` are not called at all` + the later-`open` refresh (2 fail) |
| 6 | `daemonHandshake ?? result.agentInfo` (first handshake only) | `it follows the SECOND handshake (F7)` (1 fail) |

Also caught by the suite itself and fixed (a real regression my edit introduced):
the header block dropped `queued: composeState.queued` from `sessionView`, failing
`session-screen-compose.test.ts` — restored.

### Failure modes

F1 (link down/drops) — `offline` per pull + banner + one refresh on `up`; F2
(MethodNotFound) — `unsupported` in that section only; F3 (slow MCP) — per-section
painting; F4 (not attached) — phase gate, spy count 0; F5 (stale) — generation
counter; F6 (no window/model) — "Not reported"/tokens-only, no bar; F7 —
`daemonInfo()` per handshake; F8 (not on page 1) — rows omitted, `empty` state;
F9 (huge lists) — `MAX_SKILL_ROWS` 100 + "and N more", tool names only on
expand; F10 (hostile strings) — `sanitizeDisplay` (bidi/zero-width/clamp); F11 —
auto-accept switch bound to the live link, error reported without faking a revert;
F12 (e2e slowness) — MCP connects off the start path; not measured by a real iOS
run here (see the unverified line below).

**Not verified:** the e2e flow (`25-session-info.yaml`) and the screenshots were
NOT executed in this environment — the iOS simulator run needs a Release build and
XCUITest driver, and it is the reviewer's Fable/visual step. Verify with
`bun run e2e:mobile --ios 26 --only 25-session-info`. Its static guards DO pass
(`apps/mobile/test/e2e-flows.test.ts`, 22/22: it ends on a `runScript` whose body
reads a hook and throws, and every hook it names is served).

**Gate (this branch).** `bunx tsc --noEmit` + `tsc -p apps/mobile` +
`tsc -p apps/relay` clean; `bun run lint` (biome, 1510 files) clean — the §6
baseline of 0 errors/0 warnings holds; `bun test` **10904 pass, 0 fail, 5 skip**
(425 s). The 5 skips are the documented opt-in ones (live k8s/docker, the
real-socket keepalive, a watchdog), each guarded by an opt-in variable, none in a
file this task touched. `packages/protocol/schema/protocol.json` is unchanged (no
schema change): no `protocol:bump` and no `protocol.d/` note.

## Review

*— (reviewer), (date)*

#### Owner decisions (2026-11-15 12:20, chosen on the mockups `.tentacle/tmp/mobile-ui/session-info-mockups.html`)

1. **Model name only** — no `agentInfo.provider` field, no profile.
2. **Model under the title** (`● Idle · <model>`). When the model id has slashes (e.g. `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`) show only the part after the LAST `/` (`DeepSeek-V4.1-Flash-1017`); the full id stays in the Session info sheet. Pure helper + unit test.
3. **Auto-accept: a real switch** in Session info, bound to the session's shared auto-accept (feat/session-auto-accept), gating on the laptop.
4. **Context: also in the header** — a thin bar ONLY (no "8% contesto" text) under the title line, live from `agent_usage`; the exact numbers stay in the sheet.
5. **NEW: tap the title to rename the session** — an inline edit / iOS alert with a text field, saved through the existing rename path (the TUI's `/rename`, `session/rename` or the title entry — find it with file:line), visible on every client; empty or unchanged = no-op; error state.
*— claude-opus-5-5 (orchestrator), 2026-11-15*
