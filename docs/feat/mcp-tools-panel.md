# feat/mcp-tools-panel — `/mcp` as an interactive panel that lists each server's tools

> **Status:** done (gate green; fresh-context Review waived by the owner; merged 2026-10-21)
> **Branch:** `feat/mcp-tools-panel`
> **Type:** feat · **Size:** L · **Blast:** load-bearing (breaking wire change to `mcp/status` + a new in-session modal in the `App` key/mouse router) · **Suited:** strong model; fresh-context Review mandatory per AGENTS §10 — **waived by the owner for this task (budget)**, see Review.

## Context

*— claude-opus-5-5, 2026-10-21*

`/mcp` (shipped in `docs/feat/mcp-status.md`) pushes a one-shot Markdown
notice into the transcript: one row per server with its state and a **tool
count**. The owner asked: "it doesn't show the tool names when clicking an
MCP". Two gaps make that true today:

1. **The wire carries no names.** `McpServerStatusSchema` has `tools:
   z.number()` only (`packages/protocol/src/mcp.ts:30`); the tracker fills it
   with `connection.tools.length` (`packages/mcp/src/status.ts:103`).
2. **Nothing is clickable.** The reply is a notice (`App.tsx:532-535` →
   `pushNotice(mcpStatusText(servers))`); the transcript has no hit-testing
   other than text selection (`App.tsx:868-888`).

**Decision (owner, 2026-10-21):** an interactive panel (option 3 of 3,
preferred over "names inline" and `/mcp <server>`): pick a server with ↑↓ or a
click, expand it to see its tools, Esc closes.

**Repro (capability missing), 2026-10-21, on `main` @ 690266d:** the existing
test `packages/tui/test/app.test.tsx:1165` asserts the whole `/mcp` output is
`github — ● connected · 12 tools · 4 ms` — a count, no names, no panel; the
schema test `packages/protocol/test/json-schema.test.ts:123` pins the same
count-only shape.

## Implementation

*— claude-opus-5-5, 2026-10-21*

### Load-bearing assumption

**The bottom area's on-screen position is computable from `App`'s own layout
numbers**, so a mouse click (SGR, 1-based `y`) can be mapped to a panel row
purely. Proof: the frame is top-anchored — the transcript box is exactly
`viewport` rows (`App.tsx:957`, `height={viewport}`) and existing selection
code already maps `r.y - 1` to the visible transcript row (`App.tsx:878-880`);
then `<Box marginTop={1}>` (`App.tsx:984`) puts one blank row, so the bottom
area starts at `y = viewport + 2`. While a turn runs the bottom area is
`Thinking` (1 row) + one row per queued message (`wrap="truncate-end"`), as
`activeRows` already assumes (`App.tsx:420-424`). Verified by a red/green
ink-testing-library test that clicks a row (§Tests).

### Preconditions

- Pre-public: a breaking wire change is allowed and MUST bump
  `PROTOCOL_VERSION` (`packages/protocol/src/version.ts:7`, now 7) — AGENTS §7.
- The daemon may be a pod (untrusted): every daemon string is bounded and
  control-free **by the schema** (`mcp.ts:14`, `NO_CONTROL`) and the client
  validates results on receive (`client/test/mcp-status.test.ts:108,121`).
- The daemon's WS receiver caps frames at 8 MiB (`ws-server.ts:224`); the
  result is sent the other way, but we keep it bounded anyway: 256 servers ×
  128 names × 128 chars ≈ 4 MiB worst case.
- Bare MCP tool names are known at connect time (`connect.ts:78`, `defs`);
  harness `Tool`s carry the prefixed `mcp__<server>__<tool>`
  (`tool-adapter.ts:39-41`), which is noise in a per-server list.
- Logic in pure modules, components only render (AGENTS §7): the existing
  `paletteWindow` (`commands.ts:136`) is the stateless windowing to reuse.
- Key routing: the permission dialog takes all keys first (`App.tsx:742`);
  Ctrl+C / Shift+Tab are global; mouse reports never set `key.escape`
  (the running-Esc abort at `App.tsx:799` sits before mouse parsing and works).

### Design

**Wire (breaking, v7 → v8).** `McpServerStatus` gains
`toolNames: string[]` — the server's bare MCP tool names in `tools/list`
order, each 1–128 chars and control-free, at most `MAX_MCP_TOOL_NAMES = 128`;
`tools` keeps the true count (so `tools > toolNames.length` ⇒ truncated, shown
as "… N more"). A refine enforces `toolNames.length ≤ tools`. Required (not
optional): one shape, no compat.

**Daemon.** `McpConnection` gains `toolNames` (from `defs`, `connect.ts`). The
tracker reports `toolNames` = the first 128 names made wire-safe (`oneLine`,
≤128, empty → dropped). `connecting`/`failed` → `[]`.

**TUI — pure `packages/tui/src/mcp-panel.ts`** (React-free, unit-tested):
- `McpPanel` state: `servers: readonly McpServerView[] | null` (null =
  probing), `expanded: readonly number[]` (server indices), `cursor` (index
  into the flat row list).
- `panelRows(state)`: the flat list — a `server` row per server; under an
  expanded one, one `tool` row per name, a `more` row if truncated, an `info`
  row with the error (non-connected) or "no tools".
- `panelKey(char, key)` → `up|down|toggle|expand|collapse|close|none`
  (↑↓, Enter/Space toggle, →/← expand/collapse, Esc/q close).
- `applyPanel(state, action)` → next state or `null` (closed). Collapsing from
  a child row moves the cursor to its server row.
- `panelView(state, width, maxBody)` → `{title, rows[], hint}` with rows
  windowed by `paletteWindow`, each row pre-truncated to `width` (one terminal
  row each), plus `panelHeight(view)`.
- `panelClick(state, bodyIndex, view)` → selects the row; a server row also
  toggles.
**Component `components/McpPanel.tsx`**: renders the view (PermissionPrompt
style: accent title rule, rows, dim hint). No logic.

**App wiring.** `/mcp`: no provider → notice (as today). Else open the panel
in the probing state at once (fixes the "no probing… placeholder" polish
item), call `mcpStatus()` with a generation token; on success load it into the
panel **only if this panel is still open** (fixes the "late /mcp answer after
/clear" class: a closed panel drops the answer); on failure close the panel
and push `mcpStatusError` — also only if still the same open panel.
Bottom area = (running ? Thinking + queued : nothing) + (panel ? McpPanel :
palette + input). Permission dialog still wins (render and keys); the panel
reappears after it. Keys while open: Ctrl+C / Shift+Tab global as today;
paste still goes to the (hidden) input; panel keys next; mouse reports are
still dispatched (wheel scrolls the transcript, transcript drag selects, a
press on a panel body row → `panelClick`); everything else is swallowed (no
line editing while the panel is open). `mcpStatusText` (the notice) is
removed — the panel replaces it.

### Files (dependency order)

1. `packages/protocol/src/mcp.ts`, `version.ts`, `schema/protocol.json`
   (`bun run schema:export`), `test/json-schema.test.ts`.
2. `packages/mcp/src/connect.ts`, `status.ts`, `test/status.test.ts`.
3. `packages/client/test/mcp-status.test.ts` (fixtures; client code unchanged).
4. `packages/cli/test/worker.test.ts` (real stdio fixture: names end to end).
5. `packages/tui/src/commands.ts` (`McpServerView.toolNames`, drop
   `mcpStatusText`), `mcp-panel.ts` (new), `components/McpPanel.tsx` (new),
   `App.tsx`; tests `mcp-panel.test.ts` (new), `commands.test.ts`,
   `app.test.tsx`.

### Failure modes

- **Hostile/odd names from a pod:** schema rejects control chars / overlong →
  the whole result fails validation → panel closes with "MCP status
  unavailable: …" (same as today for names). The daemon sanitizes first so a
  merely odd server never fails the result.
- **Huge tool list:** capped at 128 names; panel windows its body.
- **Probe slow / never answers:** panel shows "probing…"; Esc closes; a late
  answer is dropped (generation token).
- **Probe rejects / old daemon (MethodNotFound) / v7 peer:** a v7↔v8 pair
  fails at `initialize` (`VersionMismatch`), never mid-panel.
- **Permission prompt arrives while the panel is open:** prompt wins render +
  keys; panel state untouched; reappears after.
- **Turn running:** `/mcp` stays allowed; Thinking + queued rows stay above
  the panel; Esc closes the panel (it does not abort the turn).
- **Resize:** view recomputed each render; `maxBody` shrinks, window follows
  the cursor.
- **Click outside the panel body** (title/hint/transcript): title/hint ignored;
  transcript keeps selection behaviour.
- **Empty server list:** panel shows "No MCP servers on this daemon."

### Tests

- `mcp-panel.test.ts`: rows/expand/collapse/cursor-to-parent, truncation
  "more" row, info rows, windowing keeps cursor visible, width truncation,
  click mapping (server toggles, tool selects, out of range no-op), keys map.
- `status.test.ts`: names reported, sanitized, capped at 128, `[]` when not
  connected.
- `json-schema.test.ts`: new shape accepted; `toolNames.length > tools`,
  control char, 129 names rejected.
- `app.test.tsx`: `/mcp` opens panel ("probing…" first), Enter expands →
  names visible, Esc closes and input is back, **SGR click** on a server row
  expands it, late answer after Esc is dropped, failure → notice, no provider
  → notice; panel coexists with a running turn.
- `worker.test.ts`: the real stdio fixture's tool names come through.

## Execution

*— claude-opus-5-5, 2026-10-21*

Done in the plan's order, one narrow test file per slice.

1. **Protocol (v7 → v8).** `mcp.ts`: `tools` is now the bare names (`string[]`,
   each 1–128 chars, control-free, ≤ `MAX_MCP_TOOL_NAMES` = 128) plus
   `moreTools` (int ≥ 0); count = `tools.length + moreTools`. `version.ts` → 8;
   `schema/protocol.json` re-exported; `test/mcp.test.ts` (new),
   `json-schema.test.ts` samples, `session.test.ts` version pin relaxed to ≥ 7.
2. **mcp.** `connect.ts`: `McpConnection.toolNames` (from `defs`).
   `status.ts`: `toolList` makes names wire-safe (one line, ≤128; a name that
   cleans to empty is counted in `moreTools`, not listed), capped at 128.
3. **client/cli tests.** `client/test/mcp-status.test.ts`: fixtures to the new
   shape; the "hostile" tests now differ from an accepted payload ONLY in the
   hostile part (+ a control test proving that), + hostile tool name, + 129
   names. `cli/test/worker.test.ts`: the real stdio server's `echo` arrives by
   name.
4. **TUI.** `mcp-panel.ts` (new, pure): rows, keys, cursor, collapse-to-parent,
   windowing via `paletteWindow`, width fit, click mapping; every daemon string
   through `oneLine` (now exported from `commands.ts`). `McpPanel.tsx` (new,
   render only). `App.tsx`: panel state + generation ref; `/mcp` opens it in
   the probing state; bottom area restructured to (running rows) + (panel |
   palette + input); panel keys before the running-Esc abort; panel body clicks
   before text selection; other keys swallowed while open. `mcpStatusText` and
   its tests removed; `McpServerView` moved to `mcp-panel.ts`.

**Drift from Implementation:**
- Wire shape: the plan had `tools: number` + `toolNames` + a `refine`
  (`names ≤ count`). The JSON-Schema export (codegen gate) rejects zod
  effects (`json-schema.ts:187`), so the shape became `tools: string[]` +
  `moreTools`, which makes the invalid state unrepresentable — no refine needed.
- Unnameable tools (name cleans to empty) are counted, not dropped silently.

**Evidence.**
- Red: the 7 new App panel tests fail on `main`'s App (2 pre-existing
  behaviours — failure notice, no-provider notice — pass on both, as regression
  guards). Protocol/tracker/connect tests failed before their code.
- Non-vacuity by mutation (each restored after): `mcpBodyTop` ignoring the
  running rows → the mid-turn click test fails; no generation check on success
  → the late-answer test fails; no key swallow → the typed-`zz` test fails;
  no `oneLine` on tool names → the bidi test fails.
- Gate: `bun run check` — typecheck clean, `biome` 342 files clean,
  **1506 pass, 2 skip (the opt-in ones), 0 fail**.
- Frame (`.tentacle/tmp/mcp-tools-panel/repro.ts`, ink-testing-library, `/mcp`
  then Enter):

```
╭─ MCP servers · 2 of 3 reachable ──────────────────────────────
❯ ▾ github  ● connected · 3 tools · 41 ms
        create_issue
        list_prs
        get_file
  ▸ fs      ● connected · 1 tool · 3 ms
  ▸ db      ✗ failed
 ↑↓ select · enter expand · esc close
```

## Review

*— claude-opus-5-5, 2026-10-21 (self-check by the implementing model, NOT a
fresh-context Review: the owner waived it for budget. AGENTS §10 requires one
for `load-bearing`/`L`, so this is a recorded exception.)*

- **§7 invariants touched.** Protocol: breaking change → version bumped, both
  ends wired (schema, daemon tracker, client validates on receive), JSON
  Schema re-exported. Untrusted pod: names bounded + control-free by schema,
  bidi/zero-width stripped by the TUI before display (mutation-tested). Logic
  in a pure module; `McpPanel.tsx` only renders. No raw terminal writes; no
  new await on the RPC peer.
- **Holds:** late answers dropped (success and failure); permission prompt
  wins keys and render, panel returns after; Esc closes the panel without
  stopping a running turn; clicks map correctly idle and mid-turn; wheel still
  scrolls the transcript.
- **Known, not fixed (in `TODO.md` `/mcp` polish):** a paste or a lone `[`
  typed while the panel is open lands in the hidden input; the tool list
  includes tools that lost a name clash at register time.
- **Unverified:** a real terminal (only ink-testing-library frames). To check:
  `tentacle` with an MCP server configured → `/mcp`, click a server.
- **Should get** a fresh-context `/code-review` when budget allows, aimed at
  the `App.tsx` key/mouse routing (the known-debt handler) and the y-offset
  maths.
