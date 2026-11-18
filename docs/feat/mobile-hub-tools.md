# feat/mobile-hub-tools — A "Tools" item in the hub to switch MCP servers and skills

> **Status:** implementation (waiting for the owner's answers)
> **Branch:** `feat/mobile-hub-tools`
> **Size:** S–M · **Blast:** contained · **Suited:** DeepSeek exec + Opus review (standard, in-context)
> **Changelog:** `changelog.d/mobile-hub-tools.added.md` — `- **Tools in the hub.** On the iPhone, the floating button's fan has a Tools item (a plug) that opens a sheet listing the session's MCP servers and skills, with a switch on each to show or hide it from the model in this session. Each server's tools open in a collapsed list.`

## Context

*— claude-opus-5-5, 2026-11-18*

Owner request (TODO.md, 2026-11-17, a follow-up to the hub tasks): add a **Tools**
item to the hub fan. It opens a sheet that lists the session's MCP servers (with
their tools) and its skills, with switches to turn them on or off. The backend and
the switches already exist (`feat/session-capabilities`, merged). On the phone they
live in Session info (`apps/mobile/src/session-info.ts` `CapabilitySwitches`,
`rowSwitch`, `switchNote`; `session-info-controller.ts` `setCapability`). So this
task **reuses** them and needs **no protocol change**.

The owner picked from the mockups on 17/11
(`.tentacle/mockups/mobile-hub-tools/README.md` "CHOSEN"):
- **Q1 = B:** a plug glyph.
- **Q2 = B:** an MCP | Skills segmented control, one band per server with a
  "Visible to the model" switch, and search always shown. Each server's tools are
  **collapsed by default** and open in an accordion styled like A's.
- **Q3 = A:** a switch turns off a whole server or a whole skill. Tools are listed
  read-only and dimmed when their server is off. This is exactly what the backend
  supports today (`disabledMcp` / `disabledSkills`).

Sequencing: TODO.md puts this task **after** `mobile-hub-tap` (merged, `e6dcdd5c`)
**and** `mobile-hub-badges`, because all three touch `ui/FloatingActivity.tsx` and
the fan items. `mobile-hub-badges` is **not merged and has no task doc on `main`**
yet (`git log main | grep -i badge` shows only its two TODO commits). See Owner
question 1.

**Repro** (2026-11-18, `feat/mobile-hub-tools` = `main` @ `dc8771ef`),
`.tentacle/tmp/mobile-hub-tools/repro.ts`:

```ts
import { hubActions } from "../../worktrees/mobile-hub-tools/apps/mobile/src/hub-actions.ts";

const ctx = {
  link: "up", turn: null, ended: null, editable: true, dictation: false,
  schedules: 0, nextWakeInMs: null, unseenArtifacts: 0, activityEmpty: false,
} as const;
const noop = () => {};
// Every entry the screen wires today, plus a "tools" callback.
const entries = {
  attach: noop, activity: noop, artifacts: noop, sessions: noop, info: noop, new: noop,
  tools: noop,
} as Record<string, () => void>;
const hub = hubActions(ctx, entries);
console.log("fan :", hub.fan.map((i) => i.id).join(" · "));
console.log("more:", hub.more.map((i) => i.id).join(" · ") || "(none)");
console.log("tools offered:", hub.all.some((i) => (i.id as string) === "tools"));
```

```
$ bun .tentacle/tmp/mobile-hub-tools/repro.ts
fan : attach · activity · artifacts · sessions · info · new
more: (none)
tools offered: false
```

The repro shows two things: the hub has no Tools entry, and the idle fan already
holds exactly `FAN_MAX` = 6 items. So adding Tools pushes something into More
(Owner question 3).

## Implementation

*— claude-opus-5-5, 2026-11-18*

### Load-bearing assumption

**The Session info controller is already the single, complete source for
everything the Tools sheet draws and does.** One controller instance pulls the
MCP servers and skills, follows the switches and sends a set. A second consumer
can read the same state and call the same methods, with no new pull, feed or
wire. Evidence:
- The controller pulls `mcpStatus()` and `skills()` and follows
  `capabilities.onChange` (`session-info-controller.ts:483`, `:370-391`).
  `setCapability` is its one write (`:207`).
- `facts()` already assembles `mcp`, `skills`, `capabilities` (phase, state,
  changedBy, error), `link`, `phase` and `computerName` (`:301-336`).
- `close()` drops follows and in-flight answers but **keeps** the last
  `mcp`/`skills` values (`:582-594`; nothing there resets them). So a summary for
  the hub can read the last known counts after the sheet closes.
- The screen controller wraps it as `openInfo` / `closeInfo` / `refreshInfo`
  (`session-screen-controller.ts:1578-1589`) and exposes `state.info`
  (`:972`). `SessionScreen` passes `onSwitch → controller.setCapability`
  (`SessionScreen.tsx:1512`).

The one gap: `state()` exposes only the **projected** `SessionInfoView`
(`session-info-controller.ts:401-410`), not the raw facts. That projection is
lossy for this sheet. It caps skills at `MAX_SKILL_ROWS` = 100
(`session-info.ts:281`, `:999`), which breaks "search always", and it flattens a
server's tools into one `expand` string joined by `", "` (`:912-919`), which
breaks a per-tool accordion. The design closes the gap **additively** (below).

### Preconditions

- **No protocol change.** Switch granularity is the server or skill
  (`SessionCapabilitiesWire.disabledMcp` / `disabledSkills`,
  `session-info.ts:430-435`), which matches Q3 = A.
  `McpServerStatus.tools` is capped by the daemon at `MAX_MCP_TOOL_NAMES`, with
  `moreTools` for the rest (`packages/protocol/src/mcp.ts:30-37`).
- **Logic lives in pure modules** (AGENTS §7). The hub's rules live in
  `hub-actions.ts` (`holds`, `dimmedBecause`, `CANONICAL`, `LABELS`,
  `resolveCommit`: `:98-243`) and `hub-session.ts` (`hubContextOf` `:75`,
  `commitPlan` `:184`). The sheet's words and switches come from
  `session-info.ts` (`rowSwitch` `:518`, `switchNote` `:538`, `changedSuffix`
  `:509`, `capabilityKey` `:406`).
- **A missing callback is a missing item** (`hub-actions.ts:26`, `present`
  `:150`). With no info port (`state.info === null`,
  `session-screen-controller.ts:811`), the screen wires no `tools` entry.
- **The dimmed-item standard** (mobile-hub-tap): a dimmed item keeps its slot, and
  a commit returns a `noop` notice instead of opening a modal
  (`hub-actions.ts:36-42`, `:158-161`, `:227-231`).
- **The floating button hides under any sheet** (`SessionScreen.tsx:830-842`
  `covered`). A Tools sheet must join that list.
- **The glyph exists.** `Icon` takes SF Symbol names, checked against `SFSymbol`
  at typecheck (`ui/Icon.tsx:1-11`). The fan maps ids to glyphs in
  `ui/HubFan.tsx:27-39`. `powerplug` is added to the `IconName` union.

### Design

**D1 — One source, two projections.** `SessionInfoState` gains `tools: ToolsFacts`,
a subset of `InfoFacts`: `{ phase, link, computerName, mcp, skills, capabilities }`.
`state()` builds it from the same `facts()` call. Nothing else in the controller
changes, so there is no second pull, feed or controller. `sessionInfoView` stays as
it is.

**D2 — `apps/mobile/src/tools-view.ts` (new, pure, React-free).**
- `toolsView(facts: ToolsFacts, ui: { segment: "mcp" | "skill"; query: string; open: ReadonlySet<string> }): ToolsView`
  returns:
  - `segments`: two entries `{ id, label, count }`. The label is "MCP" or "Skills";
    the count is the number of items, or none while loading.
  - The active segment's `phase`, using the same states and words as Session
    info's sections: loading, empty, error + retry, unsupported, offline,
    not-open. The empty and error texts are **reused** from `session-info.ts` by
    exporting its two section builders' word helpers, not by copying them.
  - `bands[]`. One per server or skill: `key` (`capabilityKey`), `title`
    (sanitized), `subtitle` (built the same way as Session info: Off note,
    `changed on …`, a server's error), `switch` (`rowSwitch`, so a locked skill
    is a ghost switch, F7/F4/F1 are not interactive), and `dim`.
  - For servers only: `tools: { names: string[]; more: number } | null`. It is
    `null` unless the server is connected and has tools, so there is no
    accordion then. Each band also carries `expanded: boolean` and
    `toolsDim: boolean` (true when the server is off).
  - `note`: the segment's `switchNote` (a refused set, or why the switches are
    unusable).
  - `noMatches: boolean`.
- **Search** is case-insensitive and matches a server or skill name **or** a tool
  name. A server matched only by one of its tools is shown expanded, so the match
  is visible. An empty query shows everything. The search covers the **full**
  lists (no 100-row cap): the sheet scrolls, and the daemon already bounds both
  lists.
- **Accordion:** a band is expanded iff its key is in `ui.open` (collapsed by
  default, owner Q2) or a tool matches the search.
- `toolsSummary(facts): { known: boolean; total: number; on: number }` feeds the
  hub item. `known` requires **both** pulls to be `ready`. `total` counts servers
  plus toggleable skills (locked skills are excluded, because they cannot be
  switched). `on` counts items not in the disabled lists.

**D3 — The hub item (`hub-actions.ts`, `hub-session.ts`).**
- Add `"tools"` to `HubEntryId`, with `LABELS.tools = "Tools"`.
- `HubContext` gains `toolsEmpty: boolean`. It is true only when
  `known && total === 0`. Not loaded yet is **not** empty: unknown never dims.
- `dimmedBecause("tools")` returns
  `NO_TOOLS = "No MCP servers or skills in this session"`.
- `holds("tools")` is `true`.
- Placement in `CANONICAL` follows Owner question 3. The recommended order is
  `attach, activity, artifacts, info, tools, sessions, scheduled, dictate, new`,
  which gives the mockup's idle fan: Attach · Activity · Artifacts · Session info ·
  Tools · More.
- `hubContextOf` takes `tools: { known, total }`.
- The rim arc (Owner question 2) is a field on `HubItem`, added only if the owner
  wants it **and** `mobile-hub-badges`' arc primitive exists.

**D4 — Dimmed must not get stuck.** A server added on the laptop after a known
empty result would otherwise keep Tools dimmed forever, because a dimmed item
never opens the sheet that would refresh the counts. To prevent that, a commit on
a dimmed Tools item (the `noop` notice path) also calls a new
`controller.pullTools()`. It re-runs **only** the `mcp` and `skills` pulls,
stamped with the current generation, with no follows, and repaints. Opening
Session info refreshes the counts too.

**D5 — The sheet (`screens/ToolsSheet.tsx`, new, render-only).** It is built on
`ui/Sheet.tsx` and contains:
- the segmented control;
- an always-visible search field;
- the bands, each with a trailing RN `Switch` (`interactive = false` draws a
  disabled switch), the same component and props as `SessionInfoSheet.tsx:232`;
- a chevron that toggles the accordion. Tool names are listed read-only, with
  `+N more`, dimmed when `toolsDim`;
- the note under the bands;
- pull-to-refresh and a Retry row, both calling `controller.refreshInfo()`.

The screen owns `segment`, `query` and `open`, and resets them on every open.

**D6 — Lifecycle (`SessionScreen.tsx`).**
- `tools: openTools` sets `toolsOpen` and calls `controller.openInfo()`.
- Close sets `toolsOpen` to false and calls `controller.closeInfo()`.
- `onSwitch` is `controller.setCapability`.
- `toolsOpen` joins `covered`.
- Session info and Tools are never open at the same time: each is reached from a
  surface the other covers.

**Out of scope (by owner choice):** per-tool switches (Q3 B, which needs backend
work); "All on / All off" (A only, and not atomic); a pending spinner in the knob
(Session info doesn't have one either: rows flip on the daemon's echo).

### Files

1. `apps/mobile/src/session-info.ts`: export the section word helpers that
   `tools-view.ts` reuses (`rowSwitch`, `changedSuffix`, `switchNote`, and the
   empty/error words). No behaviour change.
2. `apps/mobile/src/session-info-controller.ts`: `SessionInfoState.tools`
   (D1), and `pullTools()` (D4).
3. `apps/mobile/src/tools-view.ts` (new): `toolsView`, `toolsSummary` (D2).
4. `apps/mobile/src/hub-actions.ts`: `tools` id, label, `toolsEmpty`, `NO_TOOLS`,
   `CANONICAL` placement (D3).
5. `apps/mobile/src/hub-session.ts`: `hubContextOf` input `tools` (D3).
6. `apps/mobile/src/session-screen-controller.ts`: expose `pullTools()` beside
   `openInfo` (D4).
7. `apps/mobile/src/ui/Icon.tsx`: add `"powerplug"`. `apps/mobile/src/ui/HubFan.tsx`:
   `GLYPH.tools = "powerplug"`.
8. `apps/mobile/src/screens/ToolsSheet.tsx` (new) (D5).
9. `apps/mobile/src/screens/SessionScreen.tsx`: entry, sheet, `covered`, dimmed
   commit calls `pullTools` (D6).
10. `changelog.d/mobile-hub-tools.added.md`.

`ui/FloatingActivity.tsx` is **not** touched unless the arc is chosen (Owner
question 2). That is what makes the hub-badges ordering soft (Owner question 1).

### Failure modes

| Case | What converges |
|---|---|
| Not attached yet (F4) | The segment says "Open the session to see …". Switches are ghosts, with `switchNote` "Open the session to turn … on or off". |
| Link down (F1) | Bands are dimmed (`link === "down"`), switches are ghosts, and the sheet keeps the last values. On link `up`, the controller re-pulls itself. |
| Older daemon without switches (F7) | Ghost switches, plus "The tentacle on X can't turn servers off — update it." A `MethodNotFound` on set leads to the same state. |
| `mcpStatus` fails | MCP segment shows "Couldn't load MCP servers · Tap to try again", and Retry calls `refreshInfo`. The Skills segment stays usable. |
| Set refused | The switch stays as it was (no optimistic flip). "Couldn't switch: …" appears under the bands until the next attempt. |
| Another device flips a switch while the sheet is open | Its echo repaints, and the subtitle gets "· changed on <device>" (Q4 machinery, `capabilityChanges`). |
| Server not connected | No accordion. The error is in the subtitle. The switch still works: hiding a broken server is legitimate. |
| Tools truncated by the daemon | `+N more` at the end of the accordion list. |
| Locked skill | Ghost switch, off, no words (Owner Q5 of session-capabilities). Not counted in the hub's `total`. |
| Both lists known and empty | Tools item is dimmed. A commit shows the notice "No MCP servers or skills in this session", plays a light haptic, opens no sheet, and runs `pullTools()` (D4). |
| Counts not known yet (no open since attach) | Tools item is **not** dimmed and has no arc. A tap opens the sheet, which shows loading. |
| One segment empty | That segment shows Session info's empty words (e.g. "No MCP servers on X · Add them under `mcpServers`…"). The other segment works. |
| Search with no hits | "No matches", and the segment's counts are unchanged. |
| A stale answer after a close or reopen | It is dropped by the controller's generation (F5). `pullTools` stamps the generation too. |
| Fan opened, then counts change before release | `resolveCommit` re-reads the context at release (`hub-actions.ts:217-243`), the existing M7 rule. |

### Tests

Each test is shown red on today's code first (§9). Fakes follow the existing ones
in `session-info-controller.test.ts` and `hub-tap-wiring.test.ts`.

- `apps/mobile/test/tools-view.test.ts` (new):
  - The segment phase for every `Pull` state.
  - Bands keyed by `capabilityKey`, with titles sanitized.
  - An off server dims its band and tools.
  - Locked skill gives a ghost switch.
  - `phase ≠ on` gives non-interactive switches and the right note.
  - A refused set's note appears in its own segment only.
  - Accordion: collapsed by default, expanded iff in `open`.
  - Search: matches by tool name, which force-expands the band; case-insensitive;
    no 100-row cap (a 150-skill fixture, the 150th found); `noMatches`.
  - `+N more`.
  - `toolsSummary`: `known` only when both are ready, locked skills excluded,
    `on`/`total`.
- `apps/mobile/test/hub-actions.test.ts` (extend):
  - Tools is offered only with a callback (P6).
  - Its place in the canonical order (Owner question 3), and that the idle fan is
    `attach · activity · artifacts · info · tools · more` with
    `sessions · new` in More.
  - `toolsEmpty` dims it.
  - `resolveCommit` on a dimmed Tools returns `noop` with `NO_TOOLS`.
  - Unknown counts never dim.
- `apps/mobile/test/session-info-controller.test.ts` (extend):
  - `state().tools` carries the same pulls the view does.
  - `pullTools()` re-runs only mcp and skills: a spy on `context` and
    `sessionList` sees no extra call.
  - A `pullTools` answer that arrives after a `close()` + `open()` from an older
    generation is dropped.
- `apps/mobile/test/hub-tools-wiring.test.ts` (new, the `hub-tap-wiring` pattern):
  - The screen wires `tools` only when `state.info !== null`.
  - The commit opens the sheet and calls `openInfo`, and close calls `closeInfo`.
  - A dimmed commit calls `pullTools` and opens nothing.
  - `toolsOpen` hides the floating button.
- Mutation check for non-vacuity: point `onSwitch` at a no-op and confirm the
  wiring test fails. Make `toolsEmpty` true while counts are unknown and confirm
  the hub test fails.

### Owner questions

1. **Order against `mobile-hub-badges`.** That task is not merged and has no plan
   yet. Without the arc, this task does not touch `FloatingActivity.tsx` or the
   badge code. **Recommendation:** run this task now, with no arc. hub-badges
   then adds the Tools arc together with its own rim-arc primitive.
2. **Is there a rim arc on the Tools item, and what does it measure?** Your pick
   "Q1 B" fixes the plug glyph. B's arc (share of items ON) draws a full ring in
   the default state, which the mockup itself flags as permanent noise that looks
   like the turn spinner. **Recommendation:** plug glyph, and the arc shows only
   the share switched **OFF** (A's rule: no arc while everything is on). It ships
   with hub-badges (question 1).
3. **Where Tools sits in the fan.** The idle fan is already full (6 items, see the
   Repro), so something moves to More. **Recommendation:** the mockup's order,
   `… artifacts, info, tools, sessions, …`, which gives an idle fan of
   Attach · Activity · Artifacts · Session info · Tools · More, with Sessions and
   New session in More (both are also reachable from the drawer and the header).
4. **Does Session info keep its own MCP/Skills switches?** **Recommendation:**
   yes, keep them for now. They are the same controller and state, so the two
   can never disagree. Revisit removing them once Tools has proven itself.

#### Orchestrator decisions (2026-11-18 05:50, owner delegated the night)
- Q1 NOT the rec: the owner asked (17/11 23:55) never to overlap dependent tasks; hub-badges is now planned+approved (branch feat/mobile-hub-badges) and touches the same fan items → this task executes AFTER hub-badges merges, and adds the Tools arc itself using badges' rim-arc primitive.
- Q2 rec: plug glyph; the arc shows only the share switched OFF (no arc while all on) — flagged for the owner's morning review (owner picked B's glyph; this takes A's arc rule).
- Q3 rec (Attach · Activity · Artifacts · Session info · Tools · More; Sessions + New session move to More). Q4 rec (Session info keeps its switches).
- Implementation APPROVED.
*— claude-opus-5-5 (orchestrator), 2026-11-18*

## Execution

*— deepseek (executor), 2026-11-18* (signed by the model that actually ran this
round: the commits `c17a24ab`/`3477ac28` say "(deepseek)", and the `Suited:` line
names DeepSeek. The `claude-sonnet-4-5` signature was a copy-paste from the
template's example; corrected in review round 2, F3. The exact deepseek version
was not recorded in those commits.)

### As built, in order (dependency order, red before green per slice)

**0. Load-bearing check (before any code).** `.tentacle/tmp/mobile-hub-tools/repro.ts`
built the idle fan from this branch's `hubActions` with the entries the screen
wires today, and printed:

```
fan : attach · activity · artifacts · sessions · info · new
more: (none)
tools offered: false
```

Matches the doc's Repro: the capability is missing, the work is real, and the
idle fan is full at six. Nothing else was derived from it.

**1. `session-info.ts` — the words, exported (no behaviour change).** The two
section builders' row loops were EXTRACTED, not copied, so `tools-view.ts` reuses
one set of sentences: `mcpRow` (`:868`), `serverTools` (`:858`), `skillRow`
(`:978`), `skillLocked` (`:973`), and the builders themselves are now exported
(`mcpSection` `:903`, `skillsSection` `:1009`). The private helpers the sheet
needs are exported too: `listOf` (`:446`), `changedSuffix` (`:525`), `rowSwitch`
(`:534`), `switchNote` (`:554`), `serverLook` (`:582`), `errorWords` (`:605`).
Two new types: `SwitchFacts` (`:168`, the fields those builders actually read)
and `ToolsFacts` (`:177`, `SwitchFacts & Pick<InfoFacts,"phase">`).
`SessionInfoSheet.tsx` renders byte-identically: the extraction moved the same
expressions into functions, and its own 149 tests stayed green.

**2. `session-info-controller.ts` — D1 and D4.** `SessionInfoState.tools:
ToolsFacts` (`:178`) is built in `state()` from the SAME `facts()` call the view
gets (`:414-430`), so the two projections can never disagree and the sheet's
counts survive `close()` (nothing resets `mcp`/`skills`). `pullTools()` (`:606`)
re-runs only `mcp` and `skills`, stamped with the current generation, installing
no follows and touching no other pull.

**3. `tools-view.ts` (new) + its test.** `toolsView(facts, ui)`, `toolsSummary`,
`toolsRim`. The segment's phase, empty/error words and retry come from
`mcpSection`/`skillsSection`; each band from `mcpRow`/`skillRow`; only what
Session info's projection loses is new: the full lists (no `MAX_SKILL_ROWS`), a
per-tool accordion, and a search that also matches tool names.

**4. The hub item.** `hub-actions.ts`: `"tools"` in `HubEntryId`, `LABELS.tools`,
`NO_TOOLS` (`:96`), `holds`/`dimmedBecause`/`CANONICAL` (`:121`, between `info`
and `sessions`) and the optional `HubItem.rim` (`:49`). `hub-session.ts`:
`hubContextOf` takes `tools?: {known,total,on}`, derives `toolsEmpty` and
`toolsRim`, and `ENTRY_IDS` gains `"tools"`.

**5. Glyph + arc.** `IconName` gains `"powerplug"`; `GLYPH.tools = "powerplug"`;
`hub-fan.ts`'s `itemRim` (`:316`) is `item.rim ?? rimFraction(item.badge)`.

**6. `session-screen-controller.ts`** exposes `pullTools()` beside
`openInfo`/`closeInfo`/`refreshInfo` (`:456`, `:1615`).

**7. `screens/ToolsSheet.tsx` (new, render-only) + `SessionScreen.tsx` wiring.**
The screen owns `toolsOpen`/`toolsSegment`/`toolsQuery`/`toolsExpanded`/
`toolsRefreshing`, wires `tools` only when `state.info !== null`, passes
`toolsSummary(info.tools)` into `hubContextOf`, joins `toolsOpen` to `covered`,
and calls `pullTools()` on the dimmed (notice) commit path.

**8. `changelog.d/mobile-hub-tools.added.md`** — the doc's one bullet, verbatim.

### Drift from Implementation (and why)

1. **The arc shipped with this task, not with hub-badges.** The orchestrator
   decided it (Q1: hub-badges merged first; the Tools arc is this task's). Since
   hub-badges' rim primitive is already in the tree (`RingArc` +
   `rimFraction` + `FanItemLook.rim`), no new drawing code was needed.
2. **`HubItem.rim?: number | null` instead of a new `HubBadge` kind.** A badge
   would also trigger badge-promotion reordering and would have to answer a
   count-shaped a11y label; `rim` is a figure, not news.
3. **`HubContext.toolsEmpty` + `toolsRim`, from ONE input.** The doc says
   `hubContextOf` takes `tools: {known,total}`; it takes `{known,total,on}` and
   derives both fields, so the arc's figure and the dim rule come from one
   argument and one summary (`toolsSummary`) rather than two call sites.
4. **`ToolsView.query` was added.** The sheet draws the search field, so the
   view-model reports back the text the person typed — the screen owns the
   state, the view-model owns what it means.
5. **`pullTools()` keeps the last counts painted while it re-asks** (no reset to
   `loading`): resetting would make the hub's own item briefly "unknown"
   (undimmed) exactly while the person is looking at it. Only the `not-open`
   branch paints (F4), because there is then nothing to keep.
6. **The sheet's note is a plain `footnote`, not a nested `BandNote`.** The first
   draft wrapped it in `BandNote` (a `<Text>`), which `BandSection`'s `footnote`
   lays out INLINE — the documented S4 review finding 1. Caught while re-reading
   the sheet against `SessionInfoSheet.tsx`'s pattern, fixed before the gate.

### Notes from the gate run (not drift)

- The 499 s whole-repo `bun test` left `packages/tui/test/__snapshots__/
  diagram-lines.test.ts.snap` with its header line corrupted (`// Bun Snapshot
  v1` replaced by a stray cursor-show escape) — a pre-existing artefact of
  running the TUI snapshot suite, not of this change (which touches no TUI
  file). The header was restored by hand and `git status` shows no change under
  `packages/tui`.

### Evidence

- **The repro** (above) — capability missing before, and after the change the
  same fan is `attach · activity · artifacts · info · tools · more` with
  `sessions · new` in More (`hub-actions.test.ts`, "the idle fan is Attach ·
  Activity · Artifacts · Session info · Tools · More").
- **Mutation 1 — `onSwitch` → a no-op** (`onSwitch={() => undefined}` in
  `SessionScreen.tsx`): `test/hub-tools-wiring.test.ts` went RED
  (`the switch is the ONE write the controller already owns`, 8 pass / 1 fail),
  then green after reverting (9 pass).
- **Mutation 2 — `toolsEmpty` true while the counts are unknown**
  (`input.tools === undefined || (…known && total === 0)` in `hub-session.ts`):
  `test/hub-actions.test.ts` went RED ("unknown counts never dim") and
  `test/hub-session.test.ts` too (2 fail), then green after reverting (87 pass).
- **Gate:** `bunx tsc --noEmit` in `apps/mobile` — clean; `bun run typecheck`
  from the root — clean (`tsc --noEmit && tsc -p apps/mobile && tsc -p apps/relay`);
  `bun run lint` — `Checked 2083 files … No fixes applied`, 0 errors / 0 warnings
  (the §6 baseline).
- **`bun test` (whole repo), once:** `15252 pass · 5 skip · 2 fail · Ran 15259
  tests across 1088 files [499.05s]`. The 5 skips are the documented opt-ins.
  **Both failures are in `packages/daemon/test/serve-log-store.test.ts`, which
  this branch does not touch** (`git status` shows no file under
  `packages/daemon`), and both are load flakes from the 499 s run: one is a
  `timed out: () => c.ended("T1")` after 20 s, the other its follow-on. Re-run in
  isolation: **`22 pass · 0 fail`**. `apps/mobile` alone: **`3558 pass · 0 fail`**.

## Review

*— claude-opus-5-5, 2026-11-18* (fresh context; same model family as the plan author, different from the executor)

**Verdict: REQUEST-CHANGES** — the code is sound; two of the plan's named properties are not pinned by any test (§9).

**Gate:** touched tests (`tools-view`, `hub-actions`, `hub-session`, `hub-tools-wiring`, `session-info-controller`, `session-info`, `hub-fan`): 265 pass · 0 fail. `bun run lint`: clean (2083 files). `bun run typecheck`: clean. I did not re-run the full `bun test` (the executor reports 15252 pass · 2 daemon load flakes, which pass on their own).

**Findings**
1. **MEDIUM — "unknown never dims" is not pinned.** `apps/mobile/src/hub-session.ts:121`. Mutation: `toolsEmpty: input.tools?.total === 0` (the `known` guard dropped) → `hub-session` + `hub-actions` still **87 pass · 0 fail**. That is exactly the state before the first open: both pulls are `loading`, so `toolsSummary` gives `{known:false,total:0}`. Under the mutation, Tools would be dimmed from attach until a dimmed tap's `pullTools` lands, with the "No MCP servers or skills" notice shown wrongly. The executor's Mutation 2 (`tools === undefined || …`) tests a different property. Needed: a test where `hubContextOf({…, tools:{known:false,total:0,on:0}})` is not `toolsEmpty`.
2. **MEDIUM — D4's convergence ("a dimmed tap un-sticks the item") is not pinned.** `apps/mobile/src/session-info-controller.ts:621`. Mutation: the `pullTools` paint guard made always-true (`mine !== generation + 99`, so the method never paints) → `session-info-controller.test.ts` still **47 pass · 0 fail**. The tests only count calls, check the stale-drop case and check `not-open`. None checks that a fresh answer replaces the last known (empty) list. Needed: open with `[]`, server added, `pullTools()`, then `state().tools.mcp` lists it, and `toolsSummary(...).total` is 1.
3. **MEDIUM (process, AGENTS §10 signing)** — the Execution is signed `claude-sonnet-4-5`, but the commit `c17a24ab` says "exec (deepseek)" and the doc's `Suited:` line says DeepSeek. The signature is how model drift is tracked, so correct it to the model that actually executed.

**Mutations (all reverted; `git status` clean afterwards):** search force-expand dropped → killed (tools-view, 2 fail); rim drawn while all on → killed; `pullTools` stale-generation guard removed → killed; `pullTools` never paints → **survived** (F2); `known` guard dropped → **survived** (F1). Executor's onSwitch mutation was not re-run: the wiring test pins that string literally.

**Attacks tried:**
- §7 "logic in pure modules": `ToolsSheet.tsx` only does presentation (the `+N more` string, the placeholder). Holds.
- One write path: `onSwitch` goes to `controller.setCapability`. Holds.
- One source: `state().tools` comes from the same `facts()` call as the view. Holds.
- Stale `pullTools` after close+open: it is dropped. Holds.
- Dimmed commit from the More/All menu: it goes through the same `commitHub`, so `pullTools` runs. Holds.
- `pullTools` when not attached: skills reads `not-open`, so `known` is false and the item is not dimmed, so a tap opens the sheet. Converges.
- No protocol, persistence or invariant change. Blast `contained` confirmed.
- Low, not blocking: with the sheet closed, `stopCaps` means another device's flip does not repaint the hub rim until the next emit. The value is read live (`current()`), so it is only stale until some other repaint.

### Round 2

*— claude-opus-5-5, 2026-11-18* (reviewing `3477ac28`, `git diff HEAD~1`, which touches only `apps/mobile/test/hub-actions.test.ts`)

**Verdict: REQUEST-CHANGES** — the fix commit breaks the gate, and two of the three findings are not addressed.

1. **HIGH — the new test does not compile and fails on unchanged code.** `apps/mobile/test/hub-actions.test.ts:580,581,588` use `loadingTools`, which is defined nowhere. Results:
   - `bun test apps/mobile/test/hub-actions.test.ts` → 53 pass · **1 fail** (`ReferenceError: loadingTools is not defined`).
   - `bun run typecheck` → 3 × TS2304.
   - `bun run lint` → 1 error (organizeImports: the `tools-view.ts` import at `:31` is out of order).
   F1 is therefore **not verified**. The `known`-guard mutation does turn the suite red, but the test is already red without it, so that proves nothing (§9). Fix: build the loading facts in the test, e.g. `{ mcp: { state: "loading" }, skills: { state: "loading" } }` plus whatever `SwitchFacts` requires. Then show it green, and red under the mutation `toolsEmpty: input.tools?.total === 0`.
2. **MEDIUM — Round-1 F2 is not addressed.** Re-ran the mutation: the `pullTools` paint guard made always-true (it never paints) → `session-info-controller.test.ts` still 47 pass · 0 fail. D4's convergence (a dimmed tap re-pulls and un-dims) is still not tested.
3. **MEDIUM — Round-1 F3 is not addressed.** The Execution is still signed `claude-sonnet-4-5` (`:327`), but the commits say DeepSeek.

Tree byte-identical after mutations (`git status` shows only this doc).

### Fix round 2

*— claude-opus-5-5, 2026-11-18* (executor of fix round 2; the round it repairs
was executed by deepseek — see the corrected Execution signature under F3)

Three fixes, each with its test **red before green** and the review's own
mutation re-run to prove it is now **killed** (§9 non-vacuity). Only two test
files changed: **no production code**.

**F1 (HIGH) — the new test did not compile: `loadingTools` existed nowhere.**
`apps/mobile/test/hub-actions.test.ts:33` (import order) and `:69-83` (the
missing fixture). The attach facts are now built explicitly and **typed**, so the
fixture cannot silently drift from `SwitchFacts`:

```ts
const LOADING_TOOLS = {
  link: "up", computerName: "MacBook Pro",
  mcp: { state: "loading" }, skills: { state: "loading" },
  capabilities: undefined,
} as const satisfies SwitchFacts;
```

The test reads `toolsSummary(LOADING_TOOLS)` (`:593-601`) instead of the
undefined name, and the `tools-view.ts` import moved after `hub-session.ts`
(organizeImports). The three previously-red gates:

```
$ bun test apps/mobile/test/hub-actions.test.ts      → 54 pass · 0 fail
$ ./node_modules/.bin/tsc -p apps/mobile --noEmit    → clean (was 3 × TS2304)
$ bun run lint                                       → clean (was 1 error)
```

F1 is now **verified**, not merely compiled: mutation `hub-session.ts:121`
`toolsEmpty: input.tools?.total === 0` (the `known` guard dropped) →

```
$ bun test apps/mobile/test/hub-actions.test.ts
(fail) the Tools item (docs/feat/mobile-hub-tools.md D3) > unknown counts never dim: a count not seen yet is not zero
 53 pass · 1 fail
```

Red on the **assertion of the property** (`:593`
`expect(toolsSummary(LOADING_TOOLS).known).toBe(false)`), not on a missing name —
exactly what `3477ac28` failed to show. Reverted (byte-compared back from the
scratch copy in `.tentacle/tmp/mobile-hub-tools/`); `git status` shows only the
two test files.

**F2 (MEDIUM) — D4's convergence was not pinned: a dimmed tap re-pulls, and the
fresh answer must un-dim the item.** New test,
`apps/mobile/test/session-info-controller.test.ts:1020-1039`, in the D4 describe.
It is the whole loop, not a call count: open with `[]` (so `known` is true and
`total` is 0 — the state that dims the item), a server appears, `pullTools()`,
then `state().tools.mcp` lists it and `toolsSummary(state().tools).total` is 1.
`toolsSummary` is imported at `:27` — the hub's own reader — so the two
projections are asserted to agree, not just the raw pull.

Mutation (the one rounds 1 and 2 both used), `session-info-controller.ts:621`
`if (mine !== generation)` → `if (mine !== generation + 99)` (the paint never
fires) →

```
$ bun test apps/mobile/test/session-info-controller.test.ts
(fail) pullTools re-runs ONLY the MCP and skill pulls (D4) > a dimmed tap un-sticks the item: a fresh answer replaces the last known list
 47 pass · 1 fail
```

**Survived** in rounds 1 and 2; **killed** now. Reverted; the other 47 still pass.

**F3 (MEDIUM, process) — the Execution was mis-signed.** It said
`claude-sonnet-4-5` while `c17a24ab`/`3477ac28` say "(deepseek)" and the doc's
`Suited:` line names DeepSeek. It now reads `*— deepseek (executor), 2026-11-18*`,
with a note that the exact deepseek version was not recorded in those commits (I
did not invent one). No code change.

**Gate** (run after the edits above, on this worktree):

```
$ bunx tsc --noEmit                     → clean (exit 0)
$ tsc -p apps/mobile --noEmit           → clean (exit 0)   (was 3 × TS2304)
$ tsc -p apps/relay --noEmit            → clean (exit 0)
$ bun run lint                          → clean, 2083 files (was 1 error)
$ bun test                              → 15255 pass · 5 skip · 0 fail, 47 snapshots
                                          (15260 tests, 1088 files, 501.87 s)
```

The 5 skips are the opt-in / environment ones AGENTS §6 lists (live-k8s,
live-docker, the real-socket keepalive, plus `skipIf` guards such as `isRoot`);
the count is unchanged from the pre-fix run, and no test I added is skipped.

**Not addressed (deliberately).** The Review's closing low ("with the sheet
closed, `stopCaps` means another device's flip does not repaint the hub rim until
the next emit") was marked non-blocking. It is a design note for *Notes/debt*:
fixing it needs a feed the closed sheet deliberately drops, which is a larger
change than a fix round should make unplanned.

