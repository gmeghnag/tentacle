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

**Load-bearing check (re-run first): HOLDS.** `SessionListEntrySchema.cwd: line(4096)` is required (`packages/protocol/src/session.ts:1513`) and the daemon fills it (`packages/daemon/src/session-host.ts:504` live, `:886` archived). No protocol change, no `protocol.d/` note, `protocol.json` untouched. The open/attach result (`session.ts:1103`) has no cwd and none was added. The entry has no hop-target label, so none is shown: a hop target's row shows whatever path its entry carries.

**Repro (feat: capability missing).** Before: `chatStatus` returned `{ text: "Idle" | "Running" | …, tone }` (the subtitle word); there was no `asking` fact (an ask showed as Running); `SessionRow`/`DrawerRow`/`SessionRoute` carried no cwd; the header subtitle was `● <word> · <model>`. The new tests were red first: `chat-header`/`folder-label` on the missing exports (new capability), and `session-list`, `drawer-list`, `drawer-nav`, `session-view-header` and `session-screen-info` (4 of 6) on their **assertions**.

**As built, in order:**
1. `src/chat-header.ts`: `ChatFacts.asking`, `ChatStatus = { dot, state, dimTitle }`, `HeaderDot`, `dotLook`, `titleLabel`. `src/session-info.ts`: the unused `headerModel`/`HeaderModel` (they pinned "status word first") are removed, with their 2 tests.
2. `src/folder-label.ts` (new): `/Users/<u>`, `/home/<u>`, `/root` → `~`; more than 5 components → `<first two>/…/<last two>`.
3. `src/session-list.ts` `SessionRow.cwd` (both row builders). `src/drawer-list.ts` `DrawerRow.folder` and `.cwd`. `src/drawer-nav.ts` `DrawerPick.cwd` → route (`""` → no key). `src/routes.ts` `SessionRoute.cwd?`. `App.tsx`: the drawer pick, the Sessions list `onOpen` → route, and `SessionRoute` → `createSessionScreen({ cwd })` (added to the effect's deps).
4. `src/session-view.ts` `headerFolder: { label, path } | null`. `src/session-screen-controller.ts` `deps.cwd?`. A one-shot `lookUpCwd()` runs after each attach while the folder is unknown (single-flight; a failure retries at the next attach; off-page → `""` → no folder). `headerCwd()` = Session info's `entryCwd` ?? lookup ?? route. `src/session-info-controller.ts` exposes `entryCwd` (like `openContext`).
5. Components: `src/ui/HeaderDot.tsx` (new: 6 pt, native-driver opacity pulse, steady under Reduce Motion, hidden from VoiceOver). `src/ui/ScreenHeader.tsx` gets `titleLead`/`titleDim`/`titleLabel` (compact only; the Rename label reads `"<title>, <state>. Rename"`). `src/screens/SessionScreen.tsx`: the subtitle is a Pressable → `openInfo()` with the folder (mono 11, `ellipsizeMode="middle"`, shrink 1) and `· model` (shrink 100, so the model gives way first). No subtitle when both are absent. `src/screens/SessionsDrawer.tsx`: a mono folder line under the title.
6. `changelog.d/mobile-header-status.changed.md`.

**Drift from Implementation:**
- `SessionInfoState.entryCwd` (new field) instead of reading the info controller's private `entry`.
- The test "opening Session info starts all four pulls" now expects `calls.list === 2`: the attach's folder lookup plus the sheet's own pull. That harness's route carries no cwd. This is intended, not a regression.
- The drawer row's VoiceOver label is unchanged (title + meta, no folder), to keep it short. Open to the reviewer.

**Tests added:** `chat-header` (every state → dot; ask > running; link down > ask; ended + running → no dot + dim; `dotLook`; `titleLabel`), `folder-label` (5), `session-list` (cwd on active/archived/pinned rows), `drawer-list` (folder; empty), `drawer-nav` (cwd on route; `""` → no key), `session-view-header` (3), `session-screen-info` (route cwd costs no list; lookup once + no re-ask; failure → none, then retried; off-page → none; info entry refreshes a stale route; a lookup landing after dispose paints nothing), `header-wiring` (4 source-wiring checks: no status word or StatusDot; the ask fact, lead, dim and label wired; mono, middle cut, tap → openInfo; the drawer folder line).

**Mutations (each applied by hand, the narrow file run, then reverted):**
| # | mutation | result |
|---|---|---|
| M1 | `chatStatus`: ask only when `!running` | KILLED (`an ask wins over the running turn`) |
| M5 | drop the `lookUpCwd()` call at attach | KILLED (3 tests) |
| M6 | lookup even when the route gave a cwd | KILLED (`route's cwd … costs no session/list`) |
| M7 | route/lookup preferred over the info entry | KILLED (`refreshes a stale route folder`) |
| M9 | drawer `folder: row.cwd` (no `folderLabel`) | KILLED |
Not mutated: the "after dispose paints nothing" test is guarded by `emit()`'s existing `disposed` check, so it pins that guard rather than new code.

**Gate:** `bun run typecheck` clean · `bun run lint` clean (1980 files, 0 errors/warnings) · `bun test`: 14434 pass, 0 fail, 5 skip. AGENTS §6 lists 3 opt-in skips. I added no skip, but I did not check whether the 5 are all opt-in.

**Not done / unverified:**
- **Simulator screenshots: NOT taken.** `e2e/run.ts:174` `firstDevice` picks the FIRST iOS-26 simulator, and the only one present is already Booted (`iPhone 17 Pro`), probably another session's. Running the harness would take it over, which goes against "use your OWN simulator". Decision needed: a dedicated simulator (a udid flag on the harness, or a cloned device), or the reviewer's run. To verify: drawer + header in light/dark, a long path, a pod path, and each dot state (running, ask, connecting, offline, not connected, ended).
- **Owner addendum 2 (copy conversation text)** landed in Context DURING execution. It is a separate capability with its own pure module, menu and VoiceOver work, and it is not in this Implementation, so it is **not implemented**. Decision needed: a new task, or an Implementation update on this branch.

*— claude-opus-5-5 (executor), 2026-11-17*

## Review

**Verdict: APPROVE (code) — merge conditional on the owner's two open decisions below.** No HIGH and no code MEDIUM in `git diff main...HEAD`.

**Gate (re-run by the reviewer):** `bun test apps/mobile/test`: 2973 pass, 0 fail · `bun run lint`: clean (1980 files) · `bun run typecheck`: clean (root + mobile + relay). The full `bun test` was NOT re-run, so the executor's "5 skips vs 3 opt-in" is still unchecked.

**Premises:** `SessionListEntrySchema.cwd` is required (`packages/protocol/src/session.ts:1513`) and the daemon fills it from `record.cwd` (`session-host.ts:504`): TRUE. No protocol or wire change, so the §7 protocol and persistence invariants are untouched. The screen repaints when the info sheet changes (`session-screen-controller.ts:782` `info.subscribe(() => emit())`), so `entryCwd` reaches the header: TRUE. `drawerTarget` with the same session id is a no-op (`drawer-nav.ts:44`), so the new `cwd` entry in the `SessionRoute` effect deps cannot tear down a live controller: TRUE.

**Attacks tried:**
1. *Precedence.* Ask vs link-down, ended vs ask, and opening/failed first all match the plan (`chat-header.ts:108-134`). Each order is pinned by its own test (`chat-header.test.ts:33,41,45,50`). Holds.
2. *The lookup is single-flight and retries after a failure.* `cwdAsking` is cleared in `finally`, and the test at `session-screen-info.test.ts:309` would fail if it were not. An off-page answer is a sticky `""`, so the header never shows another session's folder (`:340`). Holds.
3. *The `asking` fact after the sheet is dismissed* (`permission-sheet.ts:498`). The ask stays pending daemon-side but the sheet goes idle, so the dot shows "running". This matches the design ("the phone cannot answer"), so it is not a finding.
4. *`folderLabel` edge cases.* `/` gives "/", `/Users` alone stays, and `/rootfs` is not folded (it needs an exact `root`). A different user's `/Users/x` also folds to `~`; that is documented, not a finding.
5. *Session hop.* The daemon's list `cwd` is the record's static cwd (no hop handling in `session-host.ts`), so a hopped session shows its origin path, not the pod path the owner addendum asked for. The executor disclosed this honestly ("whatever path the entry carries"). It is unverified against a live hop.

**Mutation non-vacuity:** the reviewer's mutation script (`.tentacle/tmp/mobile-header-status/mut.sh`: drop the `finally` reset, ask beating link-down, the raw cwd as the label, `entryCwd` always null, ended after ask) was **not run**: this session was denied permission to execute it. Each mutated property does have a dedicated assertion (`chat-header.test.ts:41,50`, `session-screen-info.test.ts:309,348`, `session-view-header.test.ts`). The executor's M1/M5/M6/M7/M9 table is unverified by this review.

**Open (MEDIUM, process, not code):**
- **M1. Simulator screenshots are missing.** The Implementation requires screenshots of every state, light and dark, and the metadata line says "review WITH simulator screenshots". Neither the executor nor this review took them. Visual layout (the folder middle-ellipsis, the model shrinking first, dot alignment, the drawer's 2-line row height) is unverified. The owner must decide how the simulator is provided.
- **M2. Owner addendum 2 (copy text) is not implemented.** It is out of this Implementation's scope. The owner decides: a new task, or an Implementation update on this branch.

**Executor behaviour:** the scope was disciplined and the drift was disclosed (`entryCwd`, the `calls.list === 2` change). It surfaced the simulator conflict instead of taking over another session's device, and it reported its gaps honestly.

*— claude-opus-5-5, 2026-11-17* (fresh context, but the SAME model as the executor: shared blind spots may survive both passes.)
