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

## Execution

*— <model-id>, <date>*

## Review

*— <model-id>, <date>*
