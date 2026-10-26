# feat/skills-panel — `/skills`: a panel listing every skill the daemon found

> **Status:** review
> **Branch:** `feat/skills-panel`
> **Type:** feat · **Size:** L · **Blast:** load-bearing (a new wire method `skills/list`: protocol + daemon `Connection` + `RemoteClient`; the `/mcp` panel's logic is generalised) · **Suited:** strong model; fresh-context Review mandatory per AGENTS §10 — waived by the owner (budget), as for `feat/mcp-tools-panel`.

> **Superseded in part by `docs/feat/skills-hot-reload.md` (protocol 13):** the listing is no longer static nor daemon-wide — `skills/list` is replaced by `session/skills` (per session, read again from disk at each ask). The record below is historical.

## Context

*— claude-opus-5-5, 2026-10-21*

The owner asked for `/skills`: show the available skills. Today the TUI only
knows the `/name` catalog from `initialize` (`protocol/src/session.ts:103`,
built by `slashSkills`, `config/src/skills.ts:257`): user-invocable skills with
a spec name. It never sees model-only skills (`user-invocable: false`), which
skills the model is actually offered (`offeredSkills`, `skills.ts:221`, capped
at 100), where a skill comes from, or why one was skipped. Those problems are
strings (`config.skillDiagnostics`, `config/src/load.ts:251`) printed once to
stderr before Ink mounts — and only for local runtimes (`cli/src/main.ts:245`):
on `run`/`attach` the pod discovers its own skills and the laptop never sees
its problems.

**Decision (owner, 2026-10-21):** "all skills, from the daemon": every skill the
daemon discovered, who can invoke it (you / the model), and the discovery
problems; an interactive panel like `/mcp`. Doc + implementation.

**Repro (capability missing), 2026-10-21, `main` @ 2a7a913:** `/skills` →
`Unknown command: /skills. Try /help.` (`App.tsx` `default:` branch); no wire
method lists skills (`protocol/src/methods.ts:85` registry has `mcp/status`
only).

## Implementation

*— claude-opus-5-5, 2026-10-21*

### Load-bearing assumption

**A daemon's skills are fixed at start**, so the listing can be computed once
from its config and served statically. Proof: `SessionHost` builds
`skillCatalog` once in its constructor, commented "skills are fixed at daemon
start" (`daemon/src/session-host.ts:82-88`); config is loaded once per daemon
(`serve.ts:122`, `serve.ts:234`, `worker.ts:93`).

### Preconditions

- Additive method → **no version bump** (AGENTS §7): an older daemon answers
  `MethodNotFound`, which the TUI reports ("this daemon doesn't support
  /skills"), as `/mcp` does (`commands.ts` `mcpStatusError`).
- A pod daemon is untrusted: every string bounded + control-free by schema
  (client validates on receive, as for `mcp/status`), bidi/zero-width stripped
  by the TUI (`oneLine`, `commands.ts:47`).
- The `/mcp` panel's cursor/expand/window/click logic
  (`tui/src/mcp-panel.ts`) is not MCP-specific: it is generalised into
  `tree-panel.ts` and reused, not copied (AGENTS §7 "reuse the seam").
- The in-process runtime has no `SessionHost`: `main.ts` hands the TUI its
  providers directly (`main.ts:580-581`); it gets the listing the same way.

### Design

**Wire: `skills/list`** (`protocol/src/skills.ts`), params `{}`, result
`{ skills: SkillListEntry[] (≤512), problems: string[] (≤100), moreProblems: int ≥0 }`.
`SkillListEntry = { name (1–256, control-free; a non-spec name still loads),
description (1–1024), scope: "project"|"user", user: bool (a `/name` command:
in `slashSkills`), model: bool (offered to the model: in `offeredSkills`),
location (≤4096) }`.

**Daemon.** `SessionHostOptions.skillList` (raw), sanitised once by
`toSkillList` (`daemon/mapping.ts`, next to `toSkillCatalog`): one line, cut
to the caps, an entry left empty dropped; skills past 512 → one problem line.
`Connection` answers `skills/list` from it (absent → empty listing).

**CLI.** `skillListing(config)` in `wiring.ts` (raw: entries from
`config.skills` + `config.skillDiagnostics`), passed to every `SessionHost`
(`serve.ts` ×2, `worker.ts`) and, sanitised with `toSkillList`, to the
in-process TUI. `RemoteClient.skillsList()` → `local-runtime.ts`,
`connect.ts`, `main.ts` → `startTui({ skillsList })`.

**TUI.**
- `tree-panel.ts` (new, generic, pure): groups `{head, children}`, state
  `{expanded, cursor}`, rows, keys, apply, windowed view, click, height.
- `mcp-panel.ts`: reduced to the MCP projection (`mcpGroups`, title).
- `skills-panel.ts` (new): projection — head `name  who  description`
  (`you + model` / `you only` / `model only` / `hidden`), children: the
  description word-wrapped (≤8 lines), `/name` or why not, `scope · location`;
  a last group "N discovery problems" whose children are the problem lines.
- `panel.ts` (new): the open-panel union (`mcp` | `skills`), dispatching
  projection, so `App` has ONE panel state and ONE key/mouse route.
- `components/McpPanel.tsx` → `components/ListPanel.tsx` (render only).
- `App.tsx`: `/skills` opens the panel exactly like `/mcp` (generation token,
  probing placeholder, failure → notice).

### Files (dependency order)

protocol (`skills.ts`, `methods.ts`, `index.ts`, schema export, tests) →
daemon (`mapping.ts`, `session-host.ts`, `connection.ts`, tests) → client
(`remote-client.ts`, test) → cli (`wiring.ts`, `serve.ts`, `worker.ts`,
`local-runtime.ts`, `connect.ts`, `main.ts`) → tui (`commands.ts`,
`tree-panel.ts`, `mcp-panel.ts`, `skills-panel.ts`, `panel.ts`,
`ListPanel.tsx`, `App.tsx`, `run.tsx`, tests).

### Failure modes

- Old daemon → `MethodNotFound` → notice, panel closed.
- Hostile pod: control char / oversize → result rejected by the client →
  "skills unavailable: …" notice; bidi stripped on display.
- Link down → rejects at once (same guard as `mcpStatus`).
- No skills, no problems → "No skills on this daemon."
- A skill named `skills` is now shadowed by the built-in (reported by the
  existing shadowed rule in `/help`).
- Late answer after close / reopen → dropped (shared generation token).

### Tests

protocol schema accept/reject; `toSkillList` sanitising + caps; Connection
round trip; client hostile/MethodNotFound/link-down; `skillListing` flags
(user/model/hidden, cap); `tree-panel` (moved mcp behaviour tests + generic);
`skills-panel` projection (who column, wrap, problems group, bidi); App:
`/skills` opens, expands, Esc closes, failure notice, and `/mcp` still works.

## Execution

*— claude-opus-5-5, 2026-10-21*

Done in plan order, each slice green on its own test file:
- protocol `skills/list` (`protocol/src/skills.ts`, registry, schema export, `test/skills.test.ts`);
- daemon `toSkillList` + `SessionHost.skillList` + `Connection` (`test/skills-list.test.ts`);
- client `RemoteClient.skillsList()` (`client/test/skills-list.test.ts`, red first);
- cli `skillListing` (flags pinned to the agent's own rules, `wiring.test.ts`),
  wired into `serve.ts` ×2, `worker.ts`, `local-runtime.ts`, `connect.ts`, `main.ts`;
- tui pure modules: `tree-panel.ts` (generic), `mcp-panel.ts` (projection only),
  `skills-panel.ts`, `panel.ts`; `mcp-panel.test.ts` ported (same rendered rows),
  `skills-panel.test.ts`.

- `run.tsx`/`App.tsx`: `skillsList` option; the `mcpPanel` state replaced by ONE
  `OpenPanel` with a shared generation token (`openPanel`), `/mcp` and `/skills`
  both open it; keys via `treeKey` + `applyPanel`, clicks via `panelClick`;
  `components/McpPanel.tsx` → `components/ListPanel.tsx` (`git mv`).
- `commands.ts`: `/skills` in `SLASH_COMMANDS`; `requestError` shared by
  `mcpStatusError` / `skillsListError`.
- `app.test.tsx`: 8 `/skills` tests (loading → list, expand + esc, click on the
  problems row, failure notice, MethodNotFound, late answer dropped, no
  provider, `/mcp` after `/skills`); the 9 `/mcp` tests unchanged and green.

**Drift:**
- The in-process runtime gets the listing as `toSkillList(skillListing(config))`
  computed once in `main.ts` (no `SessionHost` there), so the same sanitiser
  runs on every runtime.
- Plan step 5 (an end-to-end `worker.test.ts` listing) was **not done**: the
  path is covered piecewise (`skillListing` → `toSkillList` → `Connection`
  round trip → `RemoteClient` validation → App), but no single test spans a
  real worker.
- Interruption: mid-task another session switched the shared working tree to
  `feat/mcp-remote-transport`; nothing was lost. After it merged, the owner
  moved `feat/skills-panel` onto `main` (c99c5cc) and the work continued there.

## Review

*— claude-opus-5-5, 2026-10-21* — in-context (fresh-context Review waived by the
owner for budget; AGENTS §10 asks for one at this blast radius).

**Gate:** `bun run check` green: typecheck clean, lint clean (baseline 0),
`bun test` 1627 pass, 2 skip (the opt-in live-k8s and slow-keepalive ones), 0 fail.

**Non-vacuity (mutation):**
- `case "/skills"` renamed in `App.tsx` → 6 of the 8 App tests fail ("Unknown
  command"); reverted.
- The generation check in `openPanel` made always-true → "an answer after the
  panel closed is dropped" fails; reverted.
- "/mcp after /skills" is an integration guard for the single panel state and
  is not pinned by a mutation.
- Client tests were red before `RemoteClient.skillsList` existed; the hostile
  inputs have an accepted control so they don't fail on shape alone.

**Failure modes, checked:**
- Old daemon → `MethodNotFound` → "This daemon doesn't support /skills" (App test).
- Hostile pod: control chars / oversize rejected by the schema on receive
  (client test); bidi / zero-width stripped on display (`skills-panel.test.ts`).
- Link down → rejects at once → "Skill list unavailable: …" (App test).
- Empty → "No skills on this daemon."; problems only → still a panel.
- Late answer after close → dropped (App test, mutation-checked).

**Holds:** additive method, no version bump (§7); daemon strings bounded on
both ends (§7, pod untrusted); one panel state and one key/mouse route, logic
in pure modules (`tree-panel.ts`, `skills-panel.ts`, `panel.ts`), the component
only renders (§7).

**Does not hold / debt:**
- No end-to-end worker test (see Drift).
- ~~Inherited from `/mcp`: with the panel open, a paste or a lone `[` still lands
  in the hidden input.~~ Fixed on this branch at the owner's request
  (2026-10-22), see below.

**Follow-up fix: text inserted behind an open panel.** Four inserts into the
input run outside the key path that the panel guards: a bracketed paste's end,
its timeout flush, the timer that returns a held `[`, and a Ctrl+V clipboard
read that answers late. Each one wrote into the hidden input, and the text
showed up once the panel closed. Red first, in `app.test.tsx` (`/mcp panel`):
the frames show `❯ PASTED`, `❯ CUTOFF`, `❯ [z` and `❯ CLIP`. Fix in
`App.tsx`: a `panelRef` that holds the panel as of the last render, so a timer
or a late promise reads the current value instead of a stale closure. All four
inserts are dropped while a panel is open, the same as typed keys. Gate:
1631 pass, 2 skip, 0 fail; typecheck and lint clean.
- The listing is computed at daemon start; skills edited on disk mid-session
  show up only after a restart. This is consistent with the catalog, which
  works the same way (load-bearing assumption).

**Behaviour:** the task stopped once at the usage limit and once on the
shared-tree branch switch. Both times it stopped and asked instead of forcing
git. One out-of-scope command was attempted (deleting `feat/mcp-remote-transport`)
and was blocked by the permission classifier before it ran.
