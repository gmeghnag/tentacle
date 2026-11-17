# feat/mobile-header-status — status as a small dot before the session title (no "Idle/Running" word)

> **Status:** implementation pre-approved (orchestrator 2026-11-17; owner picked the look) — executor writes the short plan, then implements
> **Branch:** `feat/mobile-header-status`
> **Size:** M · **Blast:** cross-module (apps/mobile header + drawer; possibly an additive session/list field) · **Suited:** Opus exec + Opus review WITH simulator screenshots
> **Changelog:** `changelog.d/mobile-header-status.changed.md`

## Context

Owner 2026-11-17: the header's "● Idle · Qwen3.8-27B-UD-Q…" subtitle sits badly. Mockups `.tentacle/mockups/mobile-header-status/index.html`; owner pick: **variant C "Puntino sul titolo", but KEEP the model name under the title** (subtitle = model name only, no status word, no dot there).


**Owner addendum (2026-11-17 09:53): show the working folder.** "dalla sessione si deve vedere in quale cartella sto lavorando (anche dalla sidebar, magari in piccolo mono font sotto al titolo)".
- **Sidebar (sessions drawer):** under each session's title, the session's working folder in small mono, secondary colour, home as `~`, middle-truncated (`~/tentacle/…/hop-live/proj`) so the last component always shows.
- **Session header:** subtitle = `<folder> · <model>` with the folder in mono and the model in the normal font; when space is short the MODEL truncates first, the folder middle-truncates; tapping the subtitle opens Session info (which shows the full path, selectable/copyable).
- Source: verify where the cwd reaches the phone (`session/list` items, the open/attach result, the session state; a session-hop moves it to a pod/container path — show that path, with the hop target label if the protocol has it). If a field is missing, add it ADDITIVELY (strip schemas, no protocol break) on the daemon + client + mobile mapping, with tests on both ends (AGENTS §7 protocol rule).
- Screenshots: drawer + header, light/dark, a long path, a pod path.


**Owner addendum 2 (2026-11-17 10:25): copy conversation text on the iPhone** ("devo poter copiare il testo delle conversazioni, testo mio e risposta del modello; essendo piccolo mettilo insieme a qualcos'altro").
- Long-press on a user bubble or on an assistant message → light haptic + native context menu: **Copy** (the whole message: the user's text as sent; the assistant's reply as its markdown source, so code blocks/lists survive a paste) and **Select Text** (opens the message with native text selection so a part can be copied). Code blocks also get their own Copy (if not already there).
- Must not fight existing gestures: the row swipe for timestamps (open-at-end), taps on links/artifact cards/tool rows, scrolling. Tool rows keep their own tap/expand.
- VoiceOver: a "Copy" custom action on each message.
- Pure module for "what text a message copies" (tested: user text, assistant markdown with code, a message with attachments → text only), component only wires the menu (AGENTS §7). Screenshots of the menu, light/dark.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Pre-approved shape:
- A tiny dot (6 pt) BEFORE the title, shown only when the session is NOT idle: running/streaming = accent, pulsing (Animated native driver; Reduce Motion → steady); waiting for an approval (ask) = amber steady; offline / connecting = grey hollow (connecting pulses); not connected / error = amber hollow; ended/archived = no dot, title in secondary colour. Idle = no dot at all.
- Subtitle: the model name only (truncated as today), no "Idle/Running".
- The view-model (`chat-header.ts › chatStatus`) today maps ask and queued to "Running" — add the `ask` state (from the pending permission asks the screen already knows); queued stays running (the queue is in the composer). Logic in the pure module with tests (every state → dot kind), the component only renders (AGENTS §7).
- VoiceOver: the title's accessibilityLabel includes the state ("Test, running"), since the dot is visual only.
- Light + dark; screenshots of every state in the simulator (use your OWN simulator; the e2e harness, never port 4000) in `.tentacle/tmp/mobile-header-status/shots/`.

### Executor plan (source-verified)

**Load-bearing assumption:** the folder already reaches the phone — `SessionListEntrySchema.cwd: line(4096)`, REQUIRED (`packages/protocol/src/session.ts:1513`), filled by the daemon from the session record (`packages/daemon/src/session-host.ts:504,886`). ⇒ **no protocol change**, no `protocol.d/` note. `OpenResultSchema` (`session.ts:1103`) has no cwd and none is added: the list entry is the one source. The protocol has no hop-target label on the entry; the header shows whatever path the entry carries (a pod path for a hop target) — no label invented.

**Design:**
- `chat-header.ts`: `chatStatus(facts)` → `{ dot: HeaderDot | null, state: string, dimTitle }`; `HeaderDot = "running" | "ask" | "connecting" | "offline" | "attention"`. New fact `asking: boolean` (from `state.sheet.kind === "asking"`, `permission-sheet.ts:62`). Order: opening→connecting, failed→attention, link down→offline, closed→no dot + dimTitle, asking→ask, running→running, idle→no dot. `titleLabel(title, status)` = `"Test, running"` (idle: the bare title). `dotLook(dot)` → `{ tone, hollow, pulse }` (pure, so the component only draws).
- `folder-label.ts` (new, pure): `folderLabel(cwd)` — `/Users/<u>`, `/home/<u>`, `/root` → `~`; a path over a budget middle-truncates to `<first two>/…/<last two>` so the last component always shows; the Text also sets `ellipsizeMode="middle"` for the width fit.
- Folder source on the session screen: `SessionRoute.cwd?` (drawer/list rows carry `entry.cwd`) → `SessionScreenDeps.cwd?` → `sessionView.headerFolder`. When absent (a push/new-session open), the controller asks `session/list` once after the first open through the info port and adopts the entry's cwd; the info sheet's own entry, when it lands, also refreshes it.
- Header subtitle: `<folder (mono)> · <model>`; the model `flexShrink` first, the folder middle-ellipsizes; tap → Session info. Title prefixed by `HeaderDot` (6 pt; Animated native-driver pulse; Reduce Motion → steady).
- Drawer: `DrawerRow.folder` (from `SessionRow.cwd`), a small mono secondary line under the title.

**Files:** `src/chat-header.ts`, `src/folder-label.ts`(new), `src/session-list.ts`, `src/drawer-list.ts`, `src/routes.ts`, `App.tsx`, `src/session-screen-controller.ts`, `src/session-view.ts`, `src/session-info.ts` (drop the unused `headerModel` helper's status coupling), `src/ui/ScreenHeader.tsx`, `src/ui/HeaderDot.tsx`(new), `src/screens/SessionScreen.tsx`, `src/screens/SessionsDrawer.tsx`.

**Failure modes:** empty cwd → no folder (subtitle = model only, as today); no model and no folder → no subtitle; the lookup fails / session not on the first page → no folder, no error surfaced (the info sheet already reports it); a lookup landing after dispose → ignored; ask while link down → offline wins (the phone cannot answer); ended + running → ended.

**Tests:** `test/chat-header.test.ts` (every state → dot, precedence, a11y label), `test/folder-label.test.ts`, drawer row folder (`test/drawer-list.test.ts`), view/controller folder (`test/session-view-header.test.ts`, `test/session-screen-info.test.ts`), wiring (`test/header-wiring.test.ts`).

*— claude-opus-5-5 (executor), 2026-11-17*

## Execution

## Review
