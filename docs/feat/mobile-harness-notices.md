# feat/mobile-harness-notices — the TUI's harness voice on the iPhone: `◇`/`▲`, grouped; `Compacting…` → `Compacted ✓`

> **Status:** implementation (plan written, awaiting owner approval — see *Owner questions*)
> **Branch:** `feat/mobile-harness-notices`
> **Size:** M (S1 S–M, S2 M) · **Blast:** contained (mobile-only; no protocol, persistence or TUI change) · **Suited:** Opus plan + DeepSeek exec, standard Review (fresh-context recommended for S2: it adds an RPC call path to the phone)
> **Changelog:** `changelog.d/mobile-harness-notices.changed.md` — one bullet: on the iPhone, harness lines read like the TUI's (`◇` info / `▲` warning, consecutive ones grouped), and a compaction started from the phone shows `Compacting…` → `Compacted ✓` beside the persisted `compacted · ctx A → B` separator.

## Context

*— claude-opus-5-5, 2026-11-18*

`feat/harness-notices` (merged; `docs/feat/harness-notices.md`) gave the Mac TUI
one quiet voice for harness lines: a `◇` (info) / `▲` (warning) glyph,
consecutive lines grouped under one glyph with no blank row between them (a
glyph re-opens only where the level changes — the owner is colour-blind, so
SHAPE is the signal), `/compact` shown in the spinner slot as `Compacting…` →
`Compacted ✓` (~3 s, owner 17/11), and a persisted `compacted · ctx A → B`
separator. Its Q4 (owner "ok", "senza fretta") made mobile a follow-up, with
every shared piece put in `@tentacle/core`. Owner TODO 18/11: the iPhone must
read the same, **identical live / after reload / to the Mac TUI**.

**What is already on the phone** (verified 2026-11-18, mostly from
`fix/mobile-qa-1117` and harness-notices S2.6):
- Separator from a reloaded history: `transcript-history.ts:126-127` →
  `compactionSeparatorRow` (`:45-49`, core `compactionOf` +
  `compactionSeparatorText`).
- Another device's compaction → the SAME separator, live
  (`transcript.ts:365-372`).
- The merged `again` truncation line (`transcript.ts:451-468`,
  `mergeContinueNotice` `:597`), pinned against the TUI by
  `apps/mobile/test/transcript-parity.test.ts`.

**The gaps** (this task):
1. **No level.** `NoticeRow` (`transcript-rows.ts:144-157`) has no `level`; the
   TUI marks `truncated_reply` and `empty_turn` `warn`
   (`packages/tui/src/state.ts:724`, `:730`), everything else info.
2. **No glyph, no grouping.** `NoticeRowView`
   (`screens/transcript/TranscriptRow.tsx:614-634`) draws each notice as a
   centred grey footnote in its own `Shell` (`styles.row`,
   `paddingVertical: space.transcript / 2`, `:679`), so three consecutive
   notices are three separated, glyph-less lines. The TUI's rule lives in the
   pure `packages/tui/src/harness-group.ts` (`isHarness` / `harnessLevel` /
   `joinsPrevious` / `showsGlyph`).
3. **No `Compacting…` / `Compacted ✓`.** The phone cannot compact at all: no
   hub entry (`hub-actions.ts:12-24`), no call to `RemoteSession.compact()`
   (`packages/client/src/remote-session.ts:1260`). And the daemon broadcasts no
   "compaction started" to other clients (`hosted-session.ts:3780-3835` only
   flips a private `compacting` flag), so — exactly like the TUI, which shows the
   slot only for ITS OWN `/compact` (harness-notices S3.3: "no slot state, this
   TUI never knew it ran") — the slot can exist on the phone only if the phone
   starts the compaction. This is Owner question 1.

**Repro** (2026-11-18, `.tentacle/tmp/mobile-harness-notices/repro.ts`, run with
`bun <abs path>/repro.ts` from the worktree):

```ts
// Repro: the phone's fold for a cut reply + repair + empty turn, and a reload of a compacted session.
import { apply, initialState } from "../../worktrees/mobile-harness-notices/apps/mobile/src/transcript.ts";

let s = initialState;
const ev = (e: unknown): void => {
  s = apply(s, e as never);
};
ev({ type: "turn_started", turnId: "t1", own: false });
ev({ type: "truncated_reply", reason: "length", retrying: true });
ev({ type: "history_repaired", repairs: [] });
ev({ type: "empty_turn" });
ev({ type: "turn_ended", outcome: "completed" });
for (const r of s.rows) console.log(JSON.stringify(r));
console.log("--- reload of a compacted session");
const h = apply(initialState, {
  type: "history",
  reason: null,
  messages: [
    { role: "system", content: "sys" },
    {
      role: "user",
      content: "Summary of the earlier conversation (compacted to save context):\nbrief",
      compacted: { fromTokens: 182000, toTokens: 9000 },
    },
  ],
} as never);
for (const r of h.rows) console.log(JSON.stringify(r));
```

Output:

```
{"kind":"notice","key":"r2","text":"the model returned nothing: it hit its output limit before writing anything; asking it to continue"}
{"kind":"notice","key":"r3","text":"history repaired for the model:  — the saved session is unchanged"}
{"kind":"notice","key":"r4","text":"the model returned an empty reply and did not continue when asked — nothing was produced for this turn (check the model's context window and the server's logs)"}
--- reload of a compacted session
{"kind":"notice","key":"r1","text":"compacted · ctx 182k → ~9k","separator":true}
```

The separator already holds; the two warnings (`r2`, `r4`) are indistinguishable
from the info line (`r3`) — no `level` field exists — and nothing tells the
renderer that `r2`–`r4` form one block. (The empty repair list's double space is
an artefact of the repro's `repairs: []`, not a finding.)

## Implementation

*— claude-opus-5-5, 2026-11-18*

Two slices, one branch. **S1** (levels + glyphs + grouping) touches no file of
`feat/mobile-thinking-images` except `TranscriptRow.tsx` (a different function:
`NoticeRowView` `:614-634` vs their `:155-268`), so it can run beside it.
**S2** (compact trigger + slot) draws in the footer slot `ThinkingNode`
(`ui/StepNode.tsx`, `SessionScreen.tsx:1275-1290`) which thinking-images
rewrites: execute S2 **after** thinking-images merges (Owner question 6).

### Load-bearing assumption

**The phone's transcript already draws the separator for its own compaction,
from the history activity, with the same figures the RPC result carries** — so
S2 adds only slot state and a failure line, never a second separator path.
Proof:
- The client raises a `history` activity with `reason: "compact"` for EVERY
  compaction, own included: the TUI must suppress its own one explicitly
  (`packages/tui/src/turn-feed.ts:78-91`, `ownCompaction ? "none" : "separator"`).
- The phone's feed never passes `own` (`session-feed.ts:292-304` maps only
  `messages`, `times`, `reason`), so `transcript.ts:368-371` always pushes
  `compactionSeparatorRow(key, input.messages)`.
- The summary message's `compacted` and the `CompactResult` figures are the same
  values, computed once (`packages/agent/src/session.ts:413-436`).

The executor re-checks the first point empirically in S2's controller test (a
fake session whose `compact()` raises the activity before resolving).

### Preconditions

- Core wording is shared and complete: `compactionOf`, `compactionSeparatorText`
  (`packages/core/src/compaction-view.ts`), `describeTruncation{again}`,
  `describeEmptyTurn` (`packages/core/src/truncation.ts`).
- The TUI's grouping rule is pure and small (`packages/tui/src/harness-group.ts`,
  4 functions over `{ kind, separator?, level? }`), and the mobile parity test
  already imports TUI modules test-only (`apps/mobile/test/transcript-parity.test.ts:7-20`).
- The TUI's level table: `warn` = `truncated_reply`, `empty_turn`
  (`state.ts:724`, `:730`) and a failed `/compact` (`send-now.ts:146-170`);
  info = `history_repaired` (`:735`), `dsml_leak` (`:694`), hook `context_note`
  (`:689`), `unsupported` (`:878`), notes, a cancelled compaction.
- `session/cancel` without `turnId` cancels "whatever runs, a compaction
  included" (`packages/protocol/src/session.ts:495-503`); the daemon turns the
  abort into `Cancelled` (`hosted-session.ts:3811-3814`).
- §7 "Logic lives in pure modules": the grouping decision and the slot priority
  go in pure modules; components only map them to glyphs/text.
- No protocol, persistence or TUI change: S1/S2 use existing wire methods
  (`session/compact`, `session/cancel`) and the already-persisted `compacted`
  field.

### Design

**S1 — levels, glyphs, grouping** (contained, S–M)

1. `NoticeRow.level?: "warn"` (`transcript-rows.ts`). `transcript.ts` sets it
   where the TUI does: `truncated_reply` (both the pushed and the merged line —
   `mergeContinueNotice` keeps `warn`), `empty_turn`. The phone-only notices
   take the levels of Owner question 3 (rec: `TURN_LOST_NOTICE` warn;
   `TURN_INTERRUPTED_NOTICE`, `closedNotice`, `unsupportedNotice`, notes and an
   orphan tool result info). A history-loaded row carries no level except what
   the history implies (notes → info; no cut/empty fact is persisted), which is
   also what the TUI's resume gives — so live vs reload differs exactly as on
   the Mac, never more.
2. New pure `apps/mobile/src/notice-group.ts`, a line-for-line mirror of
   `harness-group.ts` over the mobile `Row`: `isHarness(row)` (`kind ===
   "notice" && separator !== true`), `harnessLevel`, `joinsPrevious(prev, row)`,
   `showsGlyph(prev, row)`, plus one projection
   `noticeLooks(rows): ReadonlyMap<string, NoticeLook>` with
   `NoticeLook = { glyph: "◇" | "▲" | null; joined: boolean }` (keyed by row
   key, only harness rows present). "Previous" is the previous VISIBLE row: a
   row `stepLayout` hides (`HIDDEN` cells, `tool-steps.ts`) is transparent, so
   the projection takes the same `cells` map (Owner question 5).
3. `SessionScreen.tsx` memoises `noticeLooks(rows, layout.cells)` beside
   `stepLayout` (`:591`) and passes the row's look to `TranscriptRow` (a new
   optional prop; `extraData` already re-renders on row changes).
4. `NoticeRowView` renders the look (presentation only): left-aligned like the
   TUI (Owner question 2), a fixed-width glyph column (`◇` in `palette.sec`,
   `▲` in `palette.orange` as the extra cue — the shape is the signal), the
   text beside it; a `joined` row drops its top padding so the block reads as
   one; a continuation (`glyph: null`) keeps the empty glyph column so text
   hangs aligned. Separators are unchanged (centred, ruled). VoiceOver: the
   row's accessibility label prefixes "Warning:" on `▲` (the glyph is not read
   reliably).

**S2 — compaction from the phone, in the slot** (contained, M; Owner question 1)

5. New pure `apps/mobile/src/compact-slot.ts` — the phone's `slotView`, the
   TUI's priority (`packages/tui/src/spinner-slot.ts:38-70`): a running turn >
   my compaction (`compactingSince`) > `Compacted ✓` for
   `COMPACTED_SHOWN_MS = 3000` (exclusive boundary) > nothing. Plus
   `compactOutcome(result | error)` → `{ notice: string | null; level?: "warn" }`:
   success → no line (the separator says it); `Cancelled` → info
   `compaction cancelled`; a domain refusal (`TurnInProgress`,
   `CompactInProgress`, other `RpcError`) → warn `Compact failed: <message>`; a
   lost link → info `the link dropped during the compaction — the history after
   reconnect shows whether it ran` (Failure modes). Wording mirrors the TUI's
   `send-now.ts:163-166` minus its markdown underscores and its send-now clause
   (Owner question 4).
6. `transcript.ts`: one new local fold input `{ type: "local_notice"; text;
   level? }` → `pushNotice` with level (the outcome line lands in the
   transcript, grouped like any other).
7. `session-screen-controller.ts`: a `compact()` action — refuses
   (no-op) unless link up, no turn, not compacting; sets `compactingSince`,
   awaits `session.compact()`, folds `compactOutcome`, sets `compactedAt` on
   success with ONE 3 s timer to re-render; any turn start or send clears
   `compactedAt`. Exposes the slot view in the controller's state. The
   separator comes ONLY from the history activity (load-bearing assumption).
8. `hub-actions.ts`: new entry `compact` (label `Compact`, in the overflow,
   dimmed with a notice when a turn runs / link down / already compacting);
   `stop` also offered while compacting, wired to `session/cancel` without
   `turnId`.
9. Footer: `stepLayout`'s `tail` (or the screen beside it) shows the slot —
   `Compacting…` with the elapsed seconds in the Thinking node's place (same
   shimmer/static fallback thinking-images ships), `Compacted ✓` static.

### Files

S1 (dependency order):
1. `apps/mobile/src/transcript-rows.ts` — `NoticeRow.level`.
2. `apps/mobile/src/transcript.ts` — levels at `:451-475` and the phone-only
   notices; `mergeContinueNotice` keeps `level`.
3. `apps/mobile/src/notice-group.ts` (new).
4. `apps/mobile/src/screens/transcript/TranscriptRow.tsx` — `NoticeRowView`
   only + a `look` prop.
5. `apps/mobile/src/screens/SessionScreen.tsx` — memo + prop.
6. Tests: `apps/mobile/test/notice-group.test.ts` (new),
   `apps/mobile/test/transcript.test.ts`, `apps/mobile/test/transcript-parity.test.ts`.

S2:
7. `apps/mobile/src/compact-slot.ts` (new).
8. `apps/mobile/src/transcript.ts` — `local_notice` input.
9. `apps/mobile/src/session-screen-controller.ts` — `compact()`, slot state, timer.
10. `apps/mobile/src/hub-actions.ts` — `compact` entry, `stop` while compacting.
11. `apps/mobile/src/tool-steps.ts` and/or `SessionScreen.tsx` footer, `ui/StepNode.tsx` (slot text) — after thinking-images.
12. Tests: `apps/mobile/test/compact-slot.test.ts` (new),
    `session-screen-controller` and `hub-actions` tests.
13. `changelog.d/mobile-harness-notices.changed.md`.

No `packages/*` file changes (Owner question 4 is the one place that could move
the compaction wording into core).

### Failure modes

- **Hidden row between two notices** (a reasoning row folded into a step): if
  "previous" were the raw array neighbour, the glyph would re-open mid-block.
  Converges by computing over visible rows (Design 2); a test pins it.
- **The merged `again` line** replaces a `warn` in place: it must stay `warn`
  and keep its key (FlatList identity). Test.
- **Notice arrives between a turn's rows** (a hook note mid-reply): it is a
  one-line block of its own, glyph shown — same as the TUI.
- **Reload vs live**: a cut/empty warning is not persisted, so a reload shows
  no `▲` for it — identical to the TUI's resume. Notes from history group the
  same live and reloaded (the parity test runs both).
- **Own compaction, history activity lost** (link drops mid-compaction): the
  resync history (`reason: null`) replaces the transcript and `historyRows`
  draws the separator from the summary (`transcript-history.ts:126`) — or none
  if it did not run. `compact()`'s promise rejects with a transport error: the
  slot clears and the info line says the outcome is unknown, never a `▲
  Compact failed` that may be false.
- **Double separator**: impossible by construction — the result never draws
  one (load-bearing assumption); the controller test asserts exactly one.
- **Turn started by another device right after**: the slot's priority shows
  the turn at once; `Compacted ✓` is cleared on `turn_started`.
- **Prompt sent from the phone while compacting**: the daemon refuses with
  `CompactInProgress`. The executor verifies the outbox's refusal path
  (`outbox-driver.ts`) keeps the message queued (not dropped); if it drops,
  the composer queues instead of sending while `compactingSince !== null`.
- **Screen unmounts / session switches mid-compaction**: the controller's
  `dispose` clears the 3 s timer and ignores the late resolution (no fold into
  a disposed state).
- **Older daemon without figures**: separator reads `compacted` (core rule);
  unchanged.
- **Older daemon without `session/compact`**: not a real case (method exists
  since the first protocol); a `MethodNotFound` would fall into the warn
  `Compact failed` branch — honest, not silent.

### Tests

S1:
- `notice-group.test.ts`: `◇ ◇ ▲ ◇` → glyphs `◇ null ▲ ◇`, joined
  `false true true true`; a separator breaks a block; a hidden cell is
  transparent; a non-notice row breaks a block.
- `transcript.test.ts`: `truncated_reply` / `empty_turn` rows carry
  `level: "warn"`; the merged `again` keeps `warn` and the key; info notices
  carry none.
- **Parity** (`transcript-parity.test.ts`): on the shared fixtures, the app's
  `(text, level, glyph-shown, joined)` sequence equals the TUI's
  (`harness-group.ts` over the TUI state). Mutation check: flip one level in
  `transcript.ts` → parity red; revert.
- Red first: the level/group tests fail on today's code (no field, no module).

S2:
- `compact-slot.test.ts`: priority table; 2999 ms shows `Compacted ✓`, 3000
  ms does not; `compactOutcome` for success / `Cancelled` / domain error /
  transport error.
- Controller test with a fake session (match the existing fakes in the
  controller's test file): `compact()` raises the `history{compact}` activity
  then resolves → ONE separator row, slot `compacted`, then `null` after the
  fake clock passes 3 s; reject `Cancelled` → info line; transport reject → info
  "unknown" line, no `▲`; refused when a turn runs.
- `hub-actions` test: `compact` offered/dimmed per state; `stop` offered while
  compacting.

### Owner questions

1. **Compaction from the phone.** `Compacting…` → `Compacted ✓` can only exist
   for a compaction the phone itself starts (the daemon announces none, and the
   TUI shows the slot only for its own). Add a **Compact** action to the phone
   (hub overflow), or show only the separator (as for another device's)?
   **Rec: add it (S2), in the hub's overflow — otherwise the TODO's slot can
   never appear on the phone.**
2. **Alignment.** Phone notices are centred footnotes today; the TUI's are
   left-aligned with a glyph column and hanging continuation. **Rec:
   left-aligned with the glyph column, like the TUI; separators stay centred.**
3. **Levels of phone-only notices** (no TUI equivalent). **Rec: `that turn's
   stream was lost` → `▲`; `turn interrupted`, session closed, unsupported
   update, notes, orphan tool result → `◇`.**
4. **Compaction outcome wording.** The TUI's strings live in
   `packages/tui/src/send-now.ts`, unreachable from mobile. **Rec: mirror them
   in the mobile module, pinned equal by the parity test (task stays
   mobile-only, contained); moving them into `@tentacle/core` is a later
   cleanup.**
5. **Grouping across hidden rows.** **Rec: a row the step layout hides does not
   break a notice block (group over visible rows, which is what the eye sees).**
6. **Scheduling.** **Rec: S1 now, beside `feat/mobile-thinking-images` (only
   a disjoint function of `TranscriptRow.tsx` overlaps); S2 after
   thinking-images merges (both touch the Thinking footer / `StepNode.tsx`).**
7. **Stop during a phone compaction.** **Rec: yes — the hub's Stop is offered
   while the phone compacts and cancels it (`◇ compaction cancelled`).**

### Owner answers (2026-11-18 ~13:50)
Q1–Q7: all recommendations accepted (Compact action in the hub overflow; left-aligned notices with the glyph column, centred separators; ▲ for a lost turn stream, ◇ for the rest; outcome strings mirrored + parity test; group over visible rows; S1 now beside thinking-images, S2 after it merges; hub Stop cancels a phone compaction). Implementation APPROVED.
*— recorded by claude-opus-5-5 (orchestrator), 2026-11-18*

## Execution

*— deepseek-v4-pro (executor), 2026-11-18*

**Scope: S1 only.** S2 was not started (it waits for `feat/mobile-thinking-images`
to merge, Owner Q6).

### Load-bearing check, re-run first

The plan's load-bearing assumption is S2's (the client raises `history{reason:
"compact"}` for every compaction, own included), so it is untouched by S1 — but
the S1 gap itself was re-confirmed on this worktree:

- `.tentacle/tmp/mobile-harness-notices/repro-s1.ts` (the Context Repro, with the
  two extra probes appended) printed the three notices with **no `level` field on
  any of them** and `NO notice-group.ts`. Both gaps still present. The separator
  row reprinted as before, so nothing else drifted.
- After the change, `repro-s1-after.ts` on the same event sequence:

```
{"key":"r2",…,"level":"warn"}  -> {"glyph":"▲","joined":false}
{"key":"r3",…}                 -> {"glyph":"◇","joined":true}
{"key":"r4",…,"level":"warn"}  -> {"glyph":"▲","joined":true}
```

### As built (dependency order)

1. `apps/mobile/src/transcript-rows.ts` — `NoticeRow.level?: "warn"` (absent =
   info), the TUI's shape (`packages/tui/src/state.ts:71-81`).
2. `apps/mobile/src/transcript.ts` — `pushNotice(state, text, level?)`;
   `truncated_reply` and `empty_turn` pass `"warn"` (the TUI's table,
   `state.ts:724`,`:730`); `mergeContinueNotice` now keeps the row's key AND its
   level (it spreads the previous row; the no-row fallback pushes warn);
   `endTurn`/`outcomeNotice` return `{text, warn?}` — `lost` is `▲`
   (Owner Q3), `interrupted` is info, `failed` keeps its `⚠ …` text line as before.
   Phone-only notices: `closed`, `unsupported`, hook `context_note`, notes and an
   orphan tool result carry no level (info).
3. `apps/mobile/src/notice-group.ts` (new) — `NOTICE_GLYPHS`, `NoticeLook`,
   `isHarness`/`harnessLevel`/`joinsPrevious`/`showsGlyph` mirroring
   `packages/tui/src/harness-group.ts`, plus `noticeLooks(rows, cells?)`, which
   walks the VISIBLE rows (`cells` = `stepLayout`'s map; a `hidden` cell is
   skipped, so it is neither given a look nor breaks a block — Owner Q5).
4. `apps/mobile/src/screens/transcript/TranscriptRow.tsx` — `RowProps.look?`;
   `NoticeRowView` splits: a `separator` keeps the centred, ruled `Shell`
   untouched, every other notice is left-aligned in a `harness` row with a fixed
   12 pt glyph column (`◇` `palette.sec`, `▲` `palette.orange`), `joined` rows
   dropping their top padding, and a `▲` text carrying
   `accessibilityLabel: "Warning: …"`. With no `look` it falls back to the row's
   own level's glyph (a lone row / a component test).
5. `apps/mobile/src/screens/SessionScreen.tsx` — `looks = useMemo(() =>
   noticeLooks(rows, layout.cells), [rows, layout])`, added to `rowExtraData`,
   passed as `look` to a notice row only.
6. Tests: `apps/mobile/test/notice-group.test.ts` (new, pure),
   `apps/mobile/test/notice-row.test.ts` (new: the render half via the
   `chart-view.test.ts` host-stub walk + a source pin on the screen wiring),
   `apps/mobile/test/transcript.test.ts` (levels, the merged line, reload), and
   `apps/mobile/test/transcript-parity.test.ts` (a new `harness looks` block that
   runs every fixture through BOTH folds and compares
   `(text, level, glyph-shown, joined)`, plus a non-vacuity guard).
7. `changelog.d/mobile-harness-notices.changed.md`.

### Drift from the Implementation

- **`NoticeRowView` was split rather than generalised.** The plan said "renders
  the look (presentation only)"; keeping one JSX tree with the separator's rules
  inside the glyph row would have centred a separator in a glyph column. The
  separator path is now a separate early return, verbatim from before.
- **A `look`-less fallback was added** (not in the plan): the row uses its own
  `level` when no look is given. Without it a `NoticeRowView` rendered outside
  `SessionScreen` (every component test) would draw an empty glyph column.
- **An extra test file exists** (`notice-row.test.ts`) beyond the plan's three:
  the plan's S1 has no render coverage, and the level/group decisions are only
  half the feature — the glyph and the hanging alignment are the other half.
  It also carries the screen's wiring pin (`noticeLooks(rows, layout.cells)`,
  the prop, `extraData`) in `tool-rows-wiring.test.ts`'s source-assertion style.
- **A phone-only notice is NOT warned that the plan left open**: `failed` keeps
  its `⚠ …` line as a plain assistant text (the TUI's own shape, `state.ts:393`),
  not a harness line, so no `▲` is added on top of a `⚠`.

### Red before green (§9)

Every new assertion was shown failing before the code that satisfies it existed
(the first run of each file), and every plan-named target was mutation-checked
afterwards — each mutation reverted immediately:

| mutation | failed test(s) |
|---|---|
| `empty_turn` → no level (`transcript.ts`) | `transcript.test.ts`: "a cut reply and an empty turn WARN…" + parity `notice-producing-events` |
| `history_repaired` → `"warn"` (`transcript.ts`) | parity `notice-producing-events` (the phone would warn where the TUI does not) |
| merged line rebuilt as `{kind,key,text}` (drop the spread) | `transcript.test.ts`: "the merged `again` line keeps the warn level AND its key" |
| `noticeLooks` ignores `cells` (raw neighbour) | `notice-group.test.ts`: "a hidden cell is transparent: `◇ [hidden] ◇` stays ONE block" |
| `showsGlyph` always true | `notice-group.test.ts`: the S1 acceptance sequence + the level-change case + the hidden-cell case |
| glyph colour/`accessibilityLabel` warn branch removed | `notice-row.test.ts`: "a warning draws `▲` in amber and speaks its level" |
| `look` prop dropped from `TranscriptRow` in the screen | `notice-row.test.ts`: "renderItem passes it to a notice row only" |

### Narrow verification run

```
bun test apps/mobile/test/{notice-group,notice-row,transcript,transcript-parity}.test.ts   66 pass, 0 fail
bun test apps/mobile/test/{transcript,transcript-parity,transcript-reload,notice-group,
  notice-row,session-feed,stream-batch,row-times,session-view,hub-session}.test.ts        169 pass, 0 fail
bun test apps/mobile/test/{session-screen,session-screen-info,row-times,transcript-pdf}.test.ts  84 pass, 0 fail
bunx tsc -p apps/mobile                                                                   clean
bunx biome check <changed files>                                                          clean
```

One pre-existing, unrelated failure observed and NOT caused by this change:
`apps/mobile/test/step-thought-marker.test.ts` fails to load on this worktree
(`Export named 'EventEmitter' not found in expo-modules-core`) **with the
untouched `HEAD` copy of `TranscriptRow.tsx` restored**, so it is an environment
issue of that one file's mocks, not this slice.

Gate: not run by the executor (the orchestrator's script runs `bun run check`
after this). No protocol schema change, so `packages/protocol/schema/protocol.json`
is untouched; no `protocol.d/` note is needed (no wire change).

## Review

*(empty — after Execution)*
