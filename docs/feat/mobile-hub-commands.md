# feat/mobile-hub-commands — a "Commands" hub item (Compact, Clear, …), Session info under More, empty items dimmed with an in-place label

> **Status:** implementation (plan written, awaiting owner approval — see *Owner questions*)
> **Branch:** `feat/mobile-hub-commands`
> **Size:** M (C1 S–M, C2 M, C3 S–M) · **Blast:** contained (mobile) + one additive optional parameter in `packages/client` (C2) — no protocol, persistence or TUI change · **Suited:** C1 + C3 DeepSeek exec; C2 Opus exec (RPC call paths, races); fresh-context Review of C2
> **Changelog:** `changelog.d/mobile-hub-commands.added.md` — one bullet: the iPhone hub gains **Commands** (Compact with `Compacting…` → `Compacted ✓`, Clear with an inline confirm — the cleared chat is kept as an archived session —, Rename, Retry last prompt, Auto-accept); Session info moves under More; an empty Activity or Artifacts is dimmed and says so in place.

## Context

*— claude-opus-5-5, 2026-11-18*

Owner 18/11 (TODO): replace `feat/mobile-harness-notices` S2's "Compact in the
hub overflow" with a hub fan item **Commands** opening a small sheet of the
session commands the protocol already has; move **Session info** under More;
dim **Activity and Artifacts** when empty, a tap giving a light haptic and an
inline label — never an empty sheet (owner standard).

**Spec (binding):** owner-picked mockups,
`.tentacle/mockups/mobile-hub-commands/index.html` + `README.md` "## CHOSEN"
(18/11 ~14:20):
- **Q1** glyph A — a bare `>_` (1.5 stroke, same weight as the plug/paperclip);
  fan order **O1**: Attach · Activity · Artifacts · Tools · Commands · More; More
  = Sessions · **Session info** · Scheduled · Dictate · New session.
- **Q2** A — a **list** sheet: one-line explanation per command, live state
  inside the row; Clear confirms **inline** (the row opens into Cancel / Clear);
  Compact runs `Compacting…` + Stop, then `Compacted ✓ ctx A → B`, or
  `▲ Couldn't compact` + Retry; while it runs, the turn-bound rows dim and say why.
  Model & effort is **needs backend** (out).
- **Q3** A in place — the tapped empty item's OWN label becomes "Nothing
  running" / "No artifacts yet" for ~1.6 s + a light haptic.

**What is there today** (verified 2026-11-18):
- Fan composition: `apps/mobile/src/hub-actions.ts:116-126` (`CANONICAL`, Session
  info 4th), `FAN_MAX = 6` (`:88`), overflow `:225-229`. No `commands` id (`:12-23`).
- Only Activity and Tools dim (`dimmedBecause`, `:195-203`); Artifacts never does.
- A dimmed commit is a `noop` with a notice (`resolveCommit` `:277-281`) shown in
  the hub notice line (`screens/SessionScreen.tsx:1007`, `:1487`), and the
  gesture machine **closes the fan** on it (`hub-gesture.ts:159-171`: `light`
  haptic, `commit`, `close`) — so an in-place label has nowhere to show.
- `itemA11yLabel` says "nothing running" for ANY dimmed item, Tools included
  (`hub-actions.ts:401-404`) — wrong for Tools today, and for Artifacts once dimmed.
- The phone cannot compact or clear: no caller of `RemoteSession.compact()` /
  `clear()` in `apps/mobile/src` (grep), and `SendableHandle` declares neither
  (`session-screen-controller.ts:180-229`).

**Repro** (2026-11-18, `.tentacle/tmp/mobile-hub-commands/repro.ts`, run with
`bun <abs path>/repro.ts` from the worktree):

```ts
// Repro: today's hub — no Commands item, Session info in the fan, an empty Artifacts NOT dimmed,
// and a dimmed commit CLOSES the fan (so no in-place label can show).
import { hubActions, resolveCommit, hubOpen } from "../../worktrees/mobile-hub-commands/apps/mobile/src/hub-actions.ts";
import { reduce } from "../../worktrees/mobile-hub-commands/apps/mobile/src/hub-gesture.ts";
import { fanLayout } from "../../worktrees/mobile-hub-commands/apps/mobile/src/hub-fan.ts";

const noop = () => {};
const entries = Object.fromEntries(
  ["stop", "steer", "attach", "activity", "artifacts", "sessions", "info", "tools", "scheduled", "dictate", "new"].map((k) => [k, noop]),
);
const ctx = {
  link: "up" as const, turn: null, ended: null, editable: true, dictation: true, schedules: 0,
  nextWakeInMs: null, unseenArtifacts: 0, activityEmpty: true, toolsEmpty: false, toolsRim: null,
};
const hub = hubActions(ctx, entries);
console.log("fan :", hub.fan.map((i) => `${i.id}${i.dimmed ? "(dim)" : ""}`).join(" · "));
console.log("more:", hub.more.map((i) => i.id).join(" · "));
console.log("commit activity:", JSON.stringify(resolveCommit("activity", ctx, entries, hubOpen(ctx))));
const layout = fanLayout({
  anchor: { x: 350, y: 700 },
  edge: "right" as never,
  bounds: { left: 0, top: 0, right: 393, bottom: 852 } as never,
  n: hub.fan.length,
});
const menu = { layout, ids: hub.fan.map((i) => i.id), dimmed: ["activity"] };
const at = layout.kind === "fan" ? layout.items[1] : undefined;
if (at) {
  const step = reduce({ kind: "fanSticky", menu }, { type: "tapOverlay", p: { x: at.x, y: at.y } }, () => menu);
  console.log("sticky tap on dimmed activity -> state:", step.state.kind, "effects:", JSON.stringify(step.effects));
}
```

Output:

```
fan : attach · activity(dim) · artifacts · info · tools · more
more: sessions · dictate · new
commit activity: {"kind":"noop","notice":"Nothing running"}
sticky tap on dimmed activity -> state: idle effects: [{"kind":"haptic","cue":"light"},{"kind":"commit","id":"activity"},{"kind":"close"}]
```

No Commands; Session info in the fan; the empty artifact list (`unseenArtifacts:
0`, nothing presented) does not dim Artifacts; a dimmed tap closes the fan.

## Implementation

*— claude-opus-5-5, 2026-11-18*

Three slices, one branch, in this order. Executes **after**
`feat/mobile-thinking-images` (C2 draws in the Thinking footer slot it rewrites)
and **after `feat/mobile-harness-notices` S1** merges (C2 folds its `▲`/`◇`
outcome lines through S1's `NoticeRow.level`). This task **absorbs
mobile-harness-notices S2** (its Design items 5, 6, 7, 9; item 8 "Compact in the
overflow" is replaced by the Commands sheet) — Owner question 1.

### Load-bearing assumption

**The daemon behind the phone already does everything the commands need — the
phone only calls and renders.** Proof:
- Every method exists: `session/compact`, `session/clear`, `session/rename`,
  `session/set_auto_accept`, `session/cancel` (`packages/protocol/src/methods.ts:121-136`, `:232`).
- `/clear` keeps the dropped chat as a NEW archived session **daemon-side** on a
  `serve` daemon: `HostedSession.clear()` captures the chat before the barrier
  and hands it to `keepFork` (`packages/daemon/src/hosted-session.ts:3844-3892`),
  wired only when a persister exists (`session-host.ts:1565-1569`, `keepFork`
  `:1302`). The phone reaches only `serve` sessions (TODO
  `eval/container-sessions-mobile`: "today NO: the phone sees only `serve`
  sessions"), and `serve` is the daemon with a persister (AGENTS §7
  persistence) — so the phone's Clear has the TUI's semantics with no client fork.
- Compaction and clear both refuse while a turn runs (`assertIdle`,
  `hosted-session.ts:3781`, `:3845`; codes `TurnInProgress` / `CompactInProgress`
  `:3087-3090`), and a cancel during a compaction rejects it `Cancelled` with the
  history untouched (`:3810-3814`).
- The client raises `history{reason:"compact"|"clear"}` for every replacement,
  own included (mobile-harness-notices load-bearing assumption, TUI
  `useSessionLink.ts:332-338`); the phone folds `clear` as a replacement
  (`session-feed.ts:298-312`) and draws a compaction's separator from `compact`
  (`transcript.ts:365-372`). So no command draws its own transcript row except
  the outcome line.

The executor re-checks the `clear` point empirically first: a controller test
whose fake `clear()` raises `history{clear, messages: [system]}` before resolving
must leave an empty transcript + the one `◇` line (C2 Tests).

### Preconditions

- Client methods: `RemoteSession.clear()` (`packages/client/src/remote-session.ts:1217-1224`),
  `compact()` (`:1260-1266`), `rename()` (`:755`); `RemoteClient.cancel(sessionId,
  turnId?)` (`remote-client.ts:3033`). `compact`/`clear` are sent `"once"` — never
  re-sent after a drop (`remote-client.ts:2995-3006`).
- `RemoteSession.compact()` takes **no** `AbortSignal` today, unlike the TUI's
  in-process port (`packages/tui/src/app-types.ts:128` `compact?(signal?)`) — the
  one client change (C2, additive).
- The phone already renames (`controller.beginRename`, header title tap,
  `SessionScreen.tsx:1085`; `session-screen-controller.ts:1804`) and flips
  auto-accept (`controller.setAutoAccept`, Session info, `SessionScreen.tsx:1682`):
  the sheet REUSES both, no second path.
- The phone never ends a session: "no `session/close` is ever sent (decision 4,
  Hazard 3)" (`apps/mobile/src/connection.ts:132-137`) — why End & archive stays
  out (Owner question 4).
- TUI `/retry` = re-send the last prompt's TEXT (images not re-sent, said so)
  (`packages/tui/src/commands/retry.ts`, `commands.ts:117-130`, `App.tsx:340`);
  waits for an idle turn (`commands.ts:181-184`).
- Fan mechanics: the label pill is placed per highlighted index
  (`hub-fan.ts:244` `labelPlacement`); a dimmed id is already carried in the
  menu snapshot (`hub-gesture.ts:52-57`) and `light` is already a cue (`:49`).
- §7 "logic in pure modules": composition, empty state, command availability,
  the Clear confirm and the compaction slot are pure, tested modules; the
  `.tsx` only renders their view-models.

### Design

**C1 — the fan (contained, S–M)**

1. `hub-actions.ts`: new `HubEntryId` `"commands"` (label `Commands`).
   `CANONICAL` becomes `attach, activity, artifacts, tools, commands, sessions,
   info, scheduled, dictate, new`. With `FAN_MAX = 6` the idle fan is exactly O1
   (5 + More) and More starts Sessions · Session info; during a turn Stop · Steer
   push Tools and Commands into More (README Q1, accepted there). Badge promotion
   unchanged.
2. `holds("commands")` = `ctx.ended === null` (an ended session has nothing to
   run; Rename stays reachable from the title).
3. `HubContext.artifactsEmpty` (`state.artifacts.list` known and of length 0 —
   UNKNOWN is never empty, the Tools rule D3) computed in `hub-session.ts`
   `hubContextOf`. `dimmedBecause("artifacts")` → `NO_ARTIFACTS = "No artifacts yet"`.
4. `HubItem.emptyLabel: string | null` = `dimmedBecause(...)` (replaces reading
   `dimmed` alone); `dimmed` stays `emptyLabel !== null`. `itemA11yLabel` speaks
   `${label}, ${emptyLabel}` — fixes the Tools "nothing running" misread.
5. `hub-gesture.ts`: a commit on a **dimmed** id no longer commits or closes.
   It returns `{ state: fanSticky(menu, flash: { index, at: t }), effects: [haptic
   light, { kind: "flash", index }] }` — from `fanSticky` and from
   `fanTracking` (a slide-release on a dimmed item turns the fan sticky). A
   second dimmed tap restarts the flash; any other tap behaves as today.
   `FLASH_MS = 1600`.
6. New pure `hub-flash.ts`: `pillText(item, flash, now)` → the item's
   `emptyLabel` while `now - flash.at < FLASH_MS` (exclusive), else `label`; and
   `pillVisible(index, highlighted, flash, now)` (the pill shows for the
   highlighted OR the flashing item).
7. `ui/FloatingActivity.tsx` (render only): the `>_` glyph (two strokes, 1.5
   width, the plug/paperclip's viewbox); dimmed look = dashed hairline + glyph at
   38 % + grey label (README Q3, no hue); the pill text from `pillText`, one
   timer of `FLASH_MS` to re-render back; the `flash` effect plays nothing else.
8. `SessionScreen.tsx`: `commands: openCommands` in `hubEntries`. A dimmed
   commit reaching `commitHub` now comes only from the **menu/VoiceOver**
   fallback (layout `menu`, `hub-gesture.ts:149-151`) — it keeps today's notice
   line there (no fan, no pill). Tools' dimmed `pullTools()` (`:1016-1018`) moves
   to the flash path (the screen gets the flashed id from the effect).

**C2 — the commands engine (contained + 1 client param, M) — ex-harness-notices S2**

9. `packages/client/src/remote-session.ts`: `compact(signal?: AbortSignal)` —
   on abort, `this.client.cancel(id)` with no `turnId` ("whatever runs, a
   compaction included", `protocol/src/session.ts:495-503`). Mirrors the TUI port
   (`app-types.ts:128`). Additive, no wire change, no `protocol.d/` note.
10. `apps/mobile/src/compact-slot.ts` (new, = harness-notices Design 5):
    `slotView` (a running turn > my compaction `Compacting…` > `Compacted ✓` for
    `COMPACTED_SHOWN_MS = 3000`, exclusive > nothing) and
    `compactOutcome(result | error)` (success → no line, the separator says it;
    `Cancelled` → `◇ compaction cancelled`; domain refusal → `▲ Compact failed:
    <message>`, `CompactInProgress` worded "another device is compacting"; a
    transport loss → `◇ the link dropped during the compaction — the history
    after reconnect shows whether it ran`). Strings mirrored from
    `packages/tui/src/send-now.ts:146-170`, pinned by the parity test
    (harness-notices Q4).
11. `apps/mobile/src/session-commands.ts` (new, pure): the sheet's view-model.
    `commandRows(ctx) → CommandRow[]`, `CommandRow = { id: "compact" | "clear" |
    "rename" | "retry" | "autoAccept"; label; explain; state }`, `state` one of
    `ready` · `dimmed(reason)` · `confirming` (Clear) · `running` (Compact,
    Clear) · `done(text)` · `failed(text)` · `toggle(on)` (Auto-accept). Inputs:
    link, turn, ended, slot view, `confirmClear: boolean`, last user prompt (for
    Retry), auto-accept value. Rules: Compact/Clear/Retry dimmed "Waits for the
    turn to end" while a turn runs, "Not connected" on a dead link, and all three
    dimmed "Compacting…" while compacting; Retry dimmed "Nothing to retry" with
    no earlier prompt; Rename and Auto-accept never turn-bound. Plus
    `clearConfirm(state, event)` (arm / cancel / confirm; disarmed by a turn
    start or a link drop).
12. `transcript.ts`: `{ type: "local_notice"; text; level? }` → `pushNotice`
    (harness-notices Design 6) — the compaction outcome and Clear's
    `◇ chat cleared — the earlier chat is kept as an archived session` (only when
    the result's `before > after`; a no-op clear says `◇ nothing to clear`).
13. `session-screen-controller.ts`: `SendableHandle` gains optional
    `compact?(signal?)` and `clear?()` (a missing one → the row is absent, P6).
    Actions: `compact()` (refuses unless link up, idle, not compacting; holds one
    `AbortController`; folds `compactOutcome`; `compactedAt` + ONE 3 s timer),
    `cancelCompaction()`, `clear()` (same guards; folds the clear line on
    resolve; `onHistoryReplaced` already resets the context figure,
    `session-feed.ts:310-312`), `retryLast()` (the last user row's text through
    the composer's OWN send path — outbox, queue, refusal handling unchanged;
    photos not re-sent, a `◇ the photos were not re-sent` line when it had some,
    TUI parity). State exposes `slot` and `commands` (from `commandRows`).
14. `hub-actions.ts`: `stop` also holds while the phone compacts and runs
    `cancelCompaction()` (harness-notices Q7). `HubContext.compacting`.
15. Footer: the slot (`Compacting…` with elapsed seconds in the Thinking node's
    place, the thinking-images shimmer/static fallback; `Compacted ✓` static) —
    harness-notices Design 9.

**C3 — the Commands sheet (contained, S–M)**

16. `screens/CommandsSheet.tsx` (render only), the existing sheet chrome (the
    Tools/Activity sheet's): one row per `CommandRow` — title, one-line
    `explain` in `sec`, the state at the trailing edge (spinner + `Stop` while
    running; `✓ ctx A → B` from the separator's own core text,
    `compactionSeparatorText`; `▲` + `Retry` on failure; a switch for
    Auto-accept). Clear's `confirming` expands the row in place into the question
    + `Cancel` / `Clear` (Clear in `palette.red` + the word, never hue alone).
    Rename closes the sheet and calls `controller.beginRename()`. The sheet stays
    open while Compact runs (the row is its live state) and a closed sheet
    leaves the footer slot as the only state.

### Files

C1:
1. `apps/mobile/src/hub-actions.ts` — `commands`, order, `artifactsEmpty`, `emptyLabel`, a11y.
2. `apps/mobile/src/hub-session.ts` — `artifactsEmpty` in `hubContextOf`.
3. `apps/mobile/src/hub-gesture.ts` — dimmed commit → sticky + `flash`.
4. `apps/mobile/src/hub-flash.ts` (new).
5. `apps/mobile/src/ui/FloatingActivity.tsx` — glyph, dimmed look, pill text.
6. `apps/mobile/src/screens/SessionScreen.tsx` — `commands` entry, flash wiring.
7. Tests: `hub-actions`, `hub-session`, `hub-gesture` (existing files),
   `hub-flash.test.ts` (new).

C2:
8. `packages/client/src/remote-session.ts` — `compact(signal?)` (+ its test).
9. `apps/mobile/src/compact-slot.ts` (new).
10. `apps/mobile/src/session-commands.ts` (new).
11. `apps/mobile/src/transcript.ts` — `local_notice`.
12. `apps/mobile/src/session-screen-controller.ts` — compact / cancel / clear / retryLast, state.
13. `apps/mobile/src/hub-actions.ts` — `stop` while compacting.
14. Footer: `tool-steps.ts` and/or `SessionScreen.tsx`, `ui/StepNode.tsx` (as thinking-images left them).
15. Tests: `compact-slot.test.ts`, `session-commands.test.ts` (new), the
    controller's test file, `transcript.test.ts`, `transcript-parity.test.ts`
    (outcome strings), `packages/client` remote-session test.

C3:
16. `apps/mobile/src/screens/CommandsSheet.tsx` (new) + `SessionScreen.tsx` mount.
17. Test: `commands-sheet.test.ts` (the host-stub render walk of
    `notice-row.test.ts` / `chart-view.test.ts`).
18. `changelog.d/mobile-hub-commands.added.md`.

No protocol, daemon, persistence or TUI file changes.

### Failure modes

- **Command while a turn runs** (own or another device's): the rows are dimmed
  with the reason; a race (turn starts between tap and send) is refused
  `TurnInProgress` by the daemon → `▲ Compact failed: …` / `▲ Couldn't clear: …`
  line, no state change. Clear's armed confirm is disarmed by `turn_started`.
- **Compact rejected / failed**: `compactOutcome` → `▲` line + the row's Retry;
  slot cleared. Cancelled → `◇` line, row back to ready.
- **Two phones / phone + Mac**: the daemon announces no compaction start, so
  device B's Compact row is enabled during A's compaction; B's tap is refused
  `CompactInProgress` → "another device is compacting". B sees A's separator
  (`transcript.ts:365-372`); B's Clear during A's compaction: same refusal.
- **Disconnect mid-command**: `compact`/`clear` are `"once"` (never re-sent).
  The promise rejects with a transport error → slot cleared, an info line says
  the outcome is unknown; the resync history (`reason: null`) shows the truth
  (separator, or the cleared chat). Rows dim "Not connected" until link up.
- **Clear on a pod/connect session**: unreachable from the phone today (serve
  only, Load-bearing). If a future path exposes a pod session, its daemon has no
  persister → no fork, and the line would lie — so `session-commands.ts` takes a
  `forkKept: boolean` input, today always true; a test pins the false wording
  (`◇ chat cleared`, nothing about a kept copy). Eval
  `container-sessions-mobile` owns the real answer.
- **Clear with nothing to drop** (`before === after`): `◇ nothing to clear`, no
  fork claim.
- **Stop during my compaction**: hub `stop` → `cancelCompaction()` → `Cancelled`
  (`hosted-session.ts:3810-3814`). Stop after it already resolved: the abort
  finds nothing; the outcome already folded wins.
- **Retry while the link is down**: goes through the composer's send path, so it
  queues in the outbox exactly as a typed prompt (no new path).
- **Screen unmount / session switch mid-command**: controller `dispose` aborts
  nothing on the daemon (the compaction keeps running there, as for the TUI's
  detach), clears the 3 s and flash timers, ignores late resolutions.
- **Flash vs fan close**: the flash timer belongs to the fan; closing the fan
  (any path) drops it, so no stale label on the next open (test).
- **Menu / VoiceOver fallback**: no pill exists → the notice line, as today.
- **Older daemon**: every method exists since early protocol versions; a
  `MethodNotFound` lands in the `▲ … failed` branch — honest, not silent.

### Tests

Red first: every new assertion fails on today's code (no id, no module, the
repro's `close`).

C1:
- `hub-actions`: idle fan ids === `attach, activity, artifacts, tools, commands,
  more`; More starts `sessions, info`; during a turn `stop, steer, attach,
  activity, artifacts, more` with `tools, commands` in More; empty artifact list
  → Artifacts dimmed with `No artifacts yet`, UNKNOWN list → not dimmed; a11y
  label of a dimmed Tools ≠ "nothing running". Ended session → no Commands.
- `hub-gesture`: sticky tap on a dimmed item → state `fanSticky`, effects exactly
  `[haptic light, flash]`, no `commit`, no `close`; same from tracking release; a
  non-dimmed tap unchanged. Mutation: restore `close` → red.
- `hub-flash`: label at 1599 ms is the empty label, at 1600 the item label;
  a re-tap restarts.

C2:
- `compact-slot`: priority table; 2999/3000 ms boundary; `compactOutcome` for
  success / `Cancelled` / `TurnInProgress` / `CompactInProgress` / transport.
- `session-commands`: availability table per (turn, link, compacting, ended,
  last prompt); `clearConfirm` arm → cancel / confirm, disarm on turn start and
  link drop; `forkKept: false` wording.
- Controller (existing fakes of its test file): fake `compact()` raises
  `history{compact}` then resolves → ONE separator, slot `compacted`, then null
  after the fake clock passes 3 s; fake `clear()` raises `history{clear}` →
  empty transcript + ONE `◇ chat cleared — …`; abort during compact → the fake
  sees the signal, `◇ compaction cancelled`; transport reject → unknown line, no
  `▲`; `retryLast()` enqueues through the composer port with the last text.
- Client: `compact(signal)` abort sends `session/cancel` without `turnId`
  (the existing RemoteSession fake transport).
- Parity: mobile outcome strings === TUI's `send-now.ts` (minus markdown).

C3:
- `commands-sheet`: a `confirming` Clear renders Cancel + Clear in the row and
  no second sheet; a running Compact renders `Compacting…` + Stop; failure
  renders `▲` + Retry; dimmed rows render their reason. Mutation: drop the
  `confirming` branch → red.

Executor attaches **simulator screenshots** (light + dark): idle fan, a dimmed
Artifacts flashing "No artifacts yet", the sheet idle / Clear confirming /
Compacting… / Compacted ✓, More with Session info.

### Owner questions

1. **Absorb harness-notices S2 here.** The compaction engine (slot, controller,
   outcome lines, footer) moves into this task's C2; harness-notices closes at S1
   and its changelog fragment drops the "compaction from the phone" clause.
   **Rec: yes — one branch owns compaction end to end; S2's only entry point
   (overflow) is what this task replaces.**
2. **Retry last prompt in v1** (TUI `/retry`: text only, photos not re-sent, said
   in a `◇` line; through the normal send/outbox path). **Rec: include it, text
   only like the TUI.**
3. **Auto-accept row duplicates Session info's switch.** **Rec: keep both (the
   mockup has it); one controller method, one source of truth.**
4. **End & archive (`session/close`)** — the phone has never ended a session
   (`connection.ts:132-137`, decision 4). **Rec: leave it out of this task; a
   separate task if wanted (it needs the archive/reopen UX on the phone).**
5. **Tools' empty state** uses today's notice line; Q3-A covers Activity and
   Artifacts only. **Rec: give Tools the same in-place label ("No tools") — one
   rule for every dimmed item; the long sentence stays the VoiceOver label.**
6. **After a dimmed tap the fan stays open** (sticky) so the label can show.
   **Rec: yes, it stays open; the next tap commits or closes as usual.**
7. **Clear wording** — `◇ chat cleared — the earlier chat is kept as an archived
   session` (the result carries no fork id/title, so no link to it). **Rec:
   accept; a tappable link to the fork is a later task (needs `session/clear` to
   return the fork id — a protocol change).**
8. **Slicing / executors.** **Rec: C1 and C3 DeepSeek; C2 Opus (RPC paths,
   races) with a fresh-context Review; order C1 → C2 → C3, after
   thinking-images and harness-notices S1 merge.**

### Owner answers (2026-11-18 ~14:40)
Q1–Q8: all recommendations accepted (absorb harness-notices S2; Retry text-only; Auto-accept in both places; End & archive out; Tools "No tools" in place; fan stays open after a dimmed tap; Clear wording without a link — fork-id link is a later task; C1 DS → C2 Opus + fresh Review → C3 DS, after thinking-images + harness-notices S1 merge). Implementation APPROVED.
*— recorded by claude-opus-5-5 (orchestrator), 2026-11-18*

## Execution

*— DeepSeek executor (the plan's Q8 C1 assignment; the exact model id is not exposed inside the run), 2026-11-18*

### Slice C1 — the fan. DONE

**Load-bearing check re-run first** (`.tentacle/tmp/mobile-hub-commands/repro.ts`): unchanged from Context — the fan has no Commands, Session info is 4th, an empty Artifacts is not dimmed, and a dimmed sticky tap emits `[haptic light, commit, close]`. Every part held, so C1's premise (the daemon already has the commands; C1 is hub composition + the in-place label) stands.

Red first, on the assertions (not imports):
- `hub-actions.test.ts` — `NO_ARTIFACTS` missing (import), then after the source: `artifactsEmpty`, `emptyLabel`, the per-item a11y wording.
- `hub-gesture.test.ts` — 4 failures on a dimmed tap (old `commit`+`close`), printed before the fix.
- `hub-flash.test.ts` (new) — module absent, then green.

As built, in dependency order:
1. `hub-actions.ts` — `HubEntryId` gains `"commands"` (`LABELS` `Commands`); `CANONICAL` becomes `attach, activity, artifacts, tools, commands, sessions, info, scheduled, dictate, new`, so the idle fan is exactly O1 and More starts Sessions · Session info. `holds("commands") = ctx.ended === null`. `HubContext.artifactsEmpty`; `NO_ARTIFACTS = "No artifacts yet"` in `dimmedBecause`. `HubItem.emptyLabel: string | null` replaces reading `dimmed` alone (`dimmed` is now derived: `emptyLabel !== null`), and `itemA11yLabel` speaks `${label}, ${emptyLabel}` — the Tools "nothing running" misread is gone.
2. `hub-session.ts` — `hubContextOf` computes `artifactsEmpty` as `list !== undefined && list.length === 0` (UNKNOWN is never empty; the Tools D3 rule). `tapOverlay` now carries the driver's clock (`t: deps.now()`).
3. `hub-gesture.ts` — `commit` takes `at` and, for a dimmed id, returns `fanSticky + flash {index, at}` with effects exactly `[haptic light, flash]`; `GestureEffect` gains `flash`; `GestureState.fanSticky` gains an optional `flash`. Closing the fan drops it with the state.
4. `hub-flash.ts` (new) — `FLASH_MS = 1600`, `pillText(item, index, flash, now)`, `pillVisible`, `pillIndex` (one pill: the highlight wins, a live flash keeps its own). Window is half-open and rejects a backwards clock.
5. `hub-fan.ts` — `FanItemLook` gains `dashed` and `glyphOpacity`; a dimmed item is dashed + 0.38, the highlight and the resting look are solid + 1.
6. `ui/HubFan.tsx` — the dashed hairline, the glyph at `look.glyphOpacity`, the pill from `pillIndex`/`pillText`, and `CommandsGlyph` (a bare `>_`, 1.5 stroke on a 24 grid, `react-native-svg`). `npx`-free: `Svg`/`Path` are already used by the chart glyphs.
7. `ui/FloatingActivity.tsx` — the `flash` effect arms ONE `FLASH_MS` timer on an `OpenFan.flash/now`, cleared on a re-tap, on `close`, and at unmount; it plays no haptic of its own (the machine already emitted `light`). A dimmed fan tap calls a new `onFlash(id)`.
8. `screens/SessionScreen.tsx` — `commands: openCommands` in `hubEntries` (`commandsOpen`, the sheet itself is C3), and `flashHub(id)` = the Tools re-pull only (hub-tools D4), so the D4 behaviour survives on the new path.

Drift from the Implementation (and why):
- **`session-feed`/`hubContextOf` shape**: the plan says `artifactsEmpty` is "computed in `hub-session.ts` `hubContextOf`" — done — but its step-1 wording lists `HubContext.artifactsEmpty` as a field the screen sets. The screen passes the LIST only; `hubContextOf` is the single decider. No second rule, and the wiring test pins that the screen never mentions `artifactsEmpty`.
- **`tapOverlay` gained a timestamp.** The plan's `flash { index, at: t }` needs a clock, and `tapOverlay` carried none; adding `t` (from the driver's injected `now`) keeps the reducer pure rather than making it read `Date.now()`.
- **`FloatingActivity` keeps `now` in `OpenFan`** and re-reads it only when the timer fires: `pillText` needs a clock and a `Date.now()` in render would be a new value every frame.
- **`hub-flash.ts` also exports `pillIndex`** — one pill means "which item", and `pillVisible(index, …)` alone cannot answer it for a renderer.
- **The Tools re-pull on a dimmed fan tap went to a new `onFlash` prop** rather than the commit path: the plan (item 8) says a dimmed commit now comes only from the menu/VoiceOver fallback, so the fan path needed its own, sheet-free hook.

Mutations (each reverted; the test named was red with the code broken, green restored):
| mutation | red |
|---|---|
| restore the old `commit`+`close` on a dimmed id | 4 in `hub-gesture.test.ts` (sticky tap, slide-release, re-tap, drop-on-close) |
| `itemA11yLabel` back to the generic "nothing running" | 2 (dimmed a11y wording, per-item reason) |
| drop the `artifacts` branch of `dimmedBecause` | 6 across `hub-actions`/`hub-session` |
| `FLASH_MS` window made inclusive (`<=`) | 4 (`pillText` 1600 ms, `pillVisible`, `pillIndex`) |

Tests: `apps/mobile/test/` — 3678 pass, 0 fail (the three opt-in skips are the repo baseline). `tsc -p apps/mobile` clean; `biome check` on the 25 touched files clean. The full `bun run check` gate is the orchestrator's (not run here, per the token budget).

Changelog: `changelog.d/mobile-hub-commands.added.md`. No protocol, daemon, persistence, TUI or client change in C1, so no `protocol.d/` note and no schema regeneration.

Unverified: the light/dark simulator screenshots the plan asks the executor to attach (no simulator in this run) — the visual state is pinned by `hub-fan.test.ts` (dashed + 0.38, glyph path) and `hub-commands-wiring.test.ts` (the wiring) instead.

### Fix round 1

*— claude-opus-5-5 (executor, fix round 1), 2026-11-18*

**One finding, one MEDIUM — FIXED.** The adversarial Review's Finding 1 (stale highlight after a dimmed slide-release hides the next flash) reproduced exactly as written, on the branch as it stood (`.tentacle/tmp/mobile-hub-commands/stale-hi.ts`, real reducer + `hub-flash`):

```
before:  after dimmed slide-release on Activity : fanSticky hi=2 flash=2 pill#2="Nothing running"
         after flash expires (t=3000)          : hi=2 flash=2 pill#2="Activity"
         sticky tap on dimmed Steer (t=4100)    : hi=2 flash=1 pill#2="Activity"   <- reason lost
after :  after dimmed slide-release on Activity : fanSticky hi=null flash=2 pill#2="Nothing running"
         after flash expires (t=3000)          : hi=null flash=2 pill#null=""
         sticky tap on dimmed Steer (t=4100)    : hi=null flash=1 pill#1="Nothing to steer"
```

Root cause in one sentence: `commit`'s dimmed branch (`hub-gesture.ts:184`) is reachable from `tracking` `up` (`:272-275`) with the finger's highlight still standing, and it emitted no `highlight`, while `pillIndex` (`hub-flash.ts:73`) lets `hi` win over the flash — so the release's item kept the pill *and* the highlighted look for good, and every later dimmed tap's reason was masked.

**Fix** (`apps/mobile/src/hub-gesture.ts:184-197`): the dimmed branch now emits `{ highlight, index: null }` before `{ flash, index }`. That is the whole change — `FloatingActivity` already applies `highlight` (`FloatingActivity.tsx:284`), and `hub-flash.ts` is untouched: the machine owns `hi`, so it must clear it (the Review offered either this or moving `hi` into `fanSticky`; clearing at the source is the smaller diff and leaves `hi` in one place, which is `pillIndex`'s premise). Live items, the sticky tap on a live item, `close`, `cancel` and the menu/VoiceOver notice path are all unchanged.

**Tests** (`apps/mobile/test/hub-gesture.test.ts`): a new case, "a slide-release then a tap on ANOTHER dimmed item puts the pill on the second" — drives the real reducer through both gestures and feeds the applied `hi`/flash into the real `pillIndex`, asserting the pill lands on the item tapped second and on nothing once the flash expires. Two existing assertions extended for the extra effect (dimmed sticky tap, second tap on the same item). Red first, on the property, not a compile error:

```
(fail) … > a slide-release then a tap on ANOTHER dimmed item puts the pill on the second (fix round 1)
error: expect(received).toBeNull()   Received: 2      <- the release's hi, exactly the finding
```

**Mutations** (each reverted; `git status` clean of them after):

| mutation | result |
|---|---|
| drop the new `{ kind: "highlight", index: null }` (i.e. the pre-fix source) | red — 3 in `hub-gesture.test.ts`, the new one on `hi` = 2 |
| `pillIndex` → `return highlighted;` (drop the flash fallback, `hub-flash.ts:73`) | red — the new case fails on `expect(pillIndex(hi, …)).toBe(1)`, plus 2 in `hub-flash.test.ts` |

The second mutation is the non-vacuity check the fix needs: the new test binds the real `pillIndex` rather than re-deriving the pill rule, so it dies if the rule's precedence changes under it.

**Deliberately left:** the Review's Low note (two clocks for one flash — the machine's `flash.at` is never read, the renderer stamps its own `Date.now()`). Not blocking, and collapsing them means threading a clock through `HubFan`'s props; it belongs with C2/C3 if at all. **Not fixed, not a finding:** the interim `commandsOpen` no-op (C1 must not ship without C3, per plan).

`apps/mobile/test` 3680 pass / 0 fail; `biome check` clean on the two touched files; `tsc -p apps/mobile` clean. The full `bun run check` gate is the orchestrator's, per the token budget — not run here.

## Review

### Slice C1 — verification round (a second executor, same slice, no behaviour change)

*— claude-opus-5-5, 2026-11-18*

`0ede9563` was already on the branch, so this round re-verified it against the plan instead of re-implementing it; the only source edit is a doc-comment.

**Load-bearing check re-run on the current branch** (`.tentacle/tmp/mobile-hub-commands/repro.ts`, plus `c1-check.ts` for the plan's own C1 assertions):

```
fan : attach · activity(dim) · artifacts · tools · sessions · more      <- the Context repro, now STALE
sticky tap on dimmed activity -> state: fanSticky effects: [haptic light, flash {index:1}]
idle fan : attach · activity · artifacts · tools · commands · more       <- c1-check.ts
idle more: sessions · info · dictate · new
turn fan : stop · steer · attach · activity · artifacts · more
turn more: tools · commands · sessions · info · dictate · new
ended cmds: false
artifacts: "No artifacts yet" == NO_ARTIFACTS
tools dim: "No MCP servers or skills in this session"
a11y     : Activity, Nothing running | Tools
tools a11y: Tools, No MCP servers or skills in this session
unknown artifactsEmpty: false
menu commit on dimmed artifacts: {"kind":"noop","notice":"No artifacts yet"}
```

Read as expected: the Context **Repro** is now stale — the fan holds `commands`, `tools` and no `info`, More starts `sessions · info`, and a dimmed tap emits `flash` instead of `commit`+`close` — i.e. the capability Context says is missing IS present. Every C1 claim in Implementation/C1 holds.

**The load-bearing assumption itself, re-verified in source** (C1 rests on the daemon, not the phone): `session/compact`, `session/clear`, `session/rename`, `session/set_auto_accept` at `packages/protocol/src/methods.ts:121-136`; `RemoteSession.clear()` `packages/client/src/remote-session.ts:1217`, `compact()` `:1260` (still **no** signal parameter — C2 item 9 remains the one client change), `rename()` `:755`.

**Mutations, all re-run** (each reverted; the named test red while broken, green restored):

| mutation | red |
|---|---|
| restore the old `commit`+`close` on a dimmed id (`hub-gesture.ts`) | 4 in `hub-gesture.test.ts` |
| `itemA11yLabel` back to the generic "nothing running" | 2 in `hub-actions.test.ts` |
| drop `dimmedBecause`'s `artifacts` branch | 5 across `hub-actions`/`hub-session` |
| `FLASH_MS` window made inclusive (`<=`) in `hub-flash.ts` | 4 in `hub-flash.test.ts` |
| drop the `onFlash` call from the button's `flash` effect | **0** — nothing pinned it |

The last is a gap in this slice's tests, not in the plan: C1 Design 8 gives the fan tap its own sheet-free hook, and nothing held the button to calling it. Closed by a new assertion in `hub-commands-wiring.test.ts` ("the `flash` effect tells the screen once, with the fan's OWN snapshot id"), shown **red on the mutated source first**, then green on the restored one.

**The one source edit:** `HubItem.dimmed`'s doc-comment still said a dimmed commit "uses the notice line", which C1 replaced for the fan path; it now names the flash and leaves the notice line to the menu/VoiceOver answer (`hub-actions.ts:39-46`). No behaviour change.

Tests: `apps/mobile/test/hub-*.test.ts` 336 pass / 0 fail; the 36 files importing `FloatingActivity`/`HubFan`/`SessionScreen` 508 pass / 0 fail. `tsc -p apps/mobile` clean; `biome check` on the touched files clean. The full gate is the orchestrator's (§4, token budget) — not run here.

Still unverified, as above: the simulator screenshots (no simulator in this run).

### Slice C1 — adversarial review (fresh context)

*— claude-opus-5-5, 2026-11-18*

**Verdict: REQUEST-CHANGES** (one MEDIUM). Same model family as the verification round above — only a fresh context, so shared blind spots may survive.

Gate (narrow, as scoped): the 7 touched `hub-*` test files 245 pass / 0 fail; `apps/mobile/test` 3679 pass / 0 fail; `bun run lint` clean (2091 files); `bun run typecheck` clean. Full `bun test` not run (scope).

**Finding 1 (MEDIUM) — stale highlight after a dimmed slide-release hides the next flash.** `hub-gesture.ts:184-191` (`commit`, dimmed branch) is reached from `tracking` `up` (`:266-269`) but emits no `{highlight, index: null}`; before C1 every tracking release closed the fan, so a stale `hi` was impossible. `FloatingActivity` keeps `fan.hi` at the dimmed index, and `hub-flash.ts:73` `pillIndex` lets `hi` win over the flash. Repro (`.tentacle/tmp/mobile-hub-commands/stale-hi.ts`, real reducer + `hub-flash`, effects applied as `FloatingActivity` does):
```
after dimmed slide-release on Activity : fanSticky hi=2 flash=2 pill#2="Nothing running"
after flash expires (t=3000)          : hi=2 flash=2 pill#2="Activity"
sticky tap on dimmed Steer (t=4100)    : hi=2 flash=1 pill#2="Activity"
```
The second dimmed item's reason never shows (the plan's whole point, Design 5–6), and the expired item keeps its pill + highlighted look indefinitely. Fix: emit `highlight(null)` in the dimmed branch (or have the sticky state own `hi`), plus a test that a slide-release then a sticky tap on another dimmed item puts the pill on the second one — red first.

Mutations (each reverted; `git status` clean after):
| mutation | result |
|---|---|
| drop `disarmFlash()` on `close` (`FloatingActivity.tsx`) | red — 1 in `hub-commands-wiring.test.ts` |
| `tapOverlay` clock `t: deps.now()` → `t: 0` (`hub-session.ts:327`) | **green** — survives: the renderer stamps `flash.at` from its own `Date.now()` (`FloatingActivity.tsx:290`), so the machine's `flash.at` is never read. Low: two clocks for one flash; not blocking. |

Attacks tried: (a) dimmed slide-release → second dimmed tap — **found Finding 1**; (b) flash timer surviving fan close / unmount — held (pinned, mutation red); (c) menu/VoiceOver path still gets the notice line — held (`resolveCommit` unchanged, verification round's `noop` notice); (d) UNKNOWN artifacts list dims Artifacts — held (`hub-session.ts:121`). §7 "logic in pure modules": held — text/visibility decisions in `hub-flash.ts`, the `.tsx` only times. No protocol/persistence/broker invariant touched.

Note (not a finding, interim by plan): `commandsOpen` (`SessionScreen.tsx:840`) is set but never read until C3 mounts the sheet, so in C1 alone the Commands disc is a silent no-op tap — C1 must not ship without C3.
