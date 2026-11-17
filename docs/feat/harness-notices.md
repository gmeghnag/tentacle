# feat/harness-notices — one grey voice for harness lines, grouped; compaction as a slot + separator

> **Status:** implementation approved (owner 17/11) — executing S1 → S2 → S3
> **Branch:** `feat/harness-notices`
> **Size:** L (3 slices on this branch + 1 follow-up task) · **Blast:** load-bearing (S1: persisted message field, `session/compact` result) · contained (S2, S3: TUI rendering only) · **Suited:** S1 Opus + mandatory fresh-context Review; S2/S3 DeepSeek + standard Review (S3 Review red-teams the resume/foreign paths)
> **Changelog:** `changelog.d/harness-notices.changed.md` — one bullet: harness/system lines share one grey with `◇`/`▲`, consecutive ones group, `/compact` shows in the spinner slot and leaves a `compacted · ctx A → B` separator that survives `--resume`.

`Type: feat · Size: L (S1 M load-bearing, S2 M contained, S3 M contained; mobile = follow-up) · Blast: load-bearing (S1) · Suited: Opus S1, DeepSeek S2/S3, fresh Review on S1`

## Context

*— claude-opus-5-5, 2026-11-17*

Harness/system lines (a reply cut at the output limit, "Can't compact…",
compaction progress, job exits, …) are drawn by **two unrelated paths in two
colours**, each as its own item with a blank row between, all behind the `●`
the assistant and tools also use (`packages/tui/src/blink.ts:34`):

- `NoticeItem` (`packages/tui/src/state.ts:69-90`) → `noticeLines`
  (`packages/tui/src/render-lines.ts:906-925`): `●` + text in the periwinkle
  `notice` token (`packages/tui/src/theme.ts:143` dark, `:204` light). Used by
  `truncated_reply`, `empty_turn`, `dsml_leak`, `history_repaired`, job exits
  (`state.ts:575-611`).
- `pushNotice("_…_")` → `pushNoticeItem` (`state.ts:411-413`) → an
  `AssistantItem{notice:true}` rendered as markdown: accent `●` + italic text.
  46 call sites use the `_…_` single-line convention (26 `"_`, 20 `` `_ ``),
  e.g. `commands/compact.ts:25`, `useTurnDriver.ts:1168`, `send-now.ts:110`.
- Every item gets a blank row before it: `transcriptLines`
  (`render-lines.ts:969-982`) and its memoised twin `layoutTranscript`
  (`render-lines.ts:1201-1220`, "matches transcriptLines").
- A re-asked truncation that is cut again prints two near-identical lines: the
  `noticeSeenThisTurn` text-dedupe (`state.ts:231-234`, used at `:599`) lets
  `…incomplete; asking it to continue` and `…incomplete` both through
  (`packages/core/src/truncation.ts:34-43`).

Compaction today: `/compact` → `startCompaction` pushes `_Compacting the
conversation…_` (`useTurnDriver.ts:1168`), its settle pushes `_Context
compacted — N → M messages._` (`send-now.ts:107-115`). Another device's
compaction pushes `FOREIGN_COMPACTED_NOTICE` (`turn-feed.ts:74-89`). Nothing
of it is persisted: after `--resume` the compaction point is invisible and the
summary message renders as a **user row** (`›`) carrying the whole brief,
because `messagesToItems` only special-cases the restart prompt and notes
(`packages/tui/src/resume.ts:66-73`). `session/compact` returns message counts
only (`packages/protocol/src/session.ts:470-475`).

The mobile app mirrors the TUI projection: notices are centred grey footnotes
(`apps/mobile/src/screens/transcript/TranscriptRow.tsx:548-566`, `palette.sec`),
the same text-dedupe truncation pair (`apps/mobile/src/transcript.ts:452-460`),
the same foreign-compaction notice (`transcript.ts:170`, `:368-372`), a context
reset separator copied from the TUI (`apps/mobile/src/transcript-history.ts:5-28`,
`:96-101`) and no compaction marker. It has no `/compact` of its own.

**Owner decisions (2026-11-17, final; mockups
`.tentacle/mockups/harness-notices/`, ★ picks):**
1. One neutral grey for all harness info, a NEW theme token G1 `#b2b2b2` dark /
   `#4e4e4e` light (owner is colour-blind; periwinkle rejected). Glyph `◇` info,
   `▲` warning; a warning differs by SHAPE, amber on `▲` only as an extra cue.
   No `●`. The two styles today unify.
2. Grouping variant A: consecutive harness lines are ONE block — a glyph at the
   head, the rest hang under it (two-space indent), no blank rows, no border; a
   glyph re-appears only where the kind changes (◇ ↔ ▲). The duplicated
   reply-cut pair collapses into one line. Grouping is a pure view projection.
3. Compaction: no transcript line while it runs — the spinner slot shows
   `Compacting…` (same shimmer); on success the slot shows `Compacted ✓` in
   grey for 3 s (a new prompt/turn replaces it at once); the "Context compacted"
   notice goes, replaced by a full-width separator `compacted · ctx 182k → 9k`
   (no glyph, `subtle`, like the context-reset one) that survives
   `--resume`/history replay. "Can't compact…", failure and cancel stay
   harness lines.
4. Phone/Mac parity: same semantics on mobile and `serve`/`connect`.

**Repro** (2026-11-17, `.tentacle/tmp/harness-notices/today.ts`, run with
`FORCE_COLOR=3 bun today.ts` from the worktree's `.tentacle/tmp/harness-notices/`):

```ts
// Today's rendering of a reply + harness lines (feat/harness-notices repro).
import { compactedHistory } from "@tentacle/agent";
import { describeTruncation } from "@tentacle/core";
import { transcriptLines } from "../../../packages/tui/src/render-lines.ts";
import { messagesToItems } from "../../../packages/tui/src/resume.ts";
import { type DisplayState, appendNotice, pushNoticeItem } from "../../../packages/tui/src/state.ts";

let s = { items: [{ kind: "assistant", text: "Ho aggiornato il test." }] } as unknown as DisplayState;
s = appendNotice(s, describeTruncation("length", { answered: true, retrying: true }));
s = appendNotice(s, describeTruncation("length", { answered: true, retrying: false }));
s = pushNoticeItem(s, "_Can't compact while a turn is running._");
s = pushNoticeItem(s, "_Compacting the conversation…_");
s = pushNoticeItem(s, "_Context compacted — 97 → 2 messages._");
const show = (l: string) => console.log(JSON.stringify(l).replace(/\\u001b/g, "ESC"));
for (const l of transcriptLines(s.items, { width: 100 })) show(l);
console.log("--- resume of a compacted history ---");
const hist = compactedHistory([{ role: "system", content: "sys" }, { role: "user", content: "hi" }], "- goal: fix test");
for (const it of messagesToItems(hist)) console.log(JSON.stringify(it));
```

```
"ESC[38;2;6;182;212m●ESC[39m ESC[0mHo aggiornato il test.ESC[0m"
""
"ESC[38;2;140;170;238m●ESC[39m ESC[38;2;140;170;238mthe reply was cut at the model's output limit — this answer is incomplete; asking it to continueESC[39m"
""
"ESC[38;2;140;170;238m●ESC[39m ESC[38;2;140;170;238mthe reply was cut at the model's output limit — this answer is incompleteESC[39m"
""
"ESC[38;2;6;182;212m●ESC[39m ESC[0mESC[3mCan't compact while a turn is running.ESC[23mESC[0m"
""
"ESC[38;2;6;182;212m●ESC[39m ESC[0mESC[3mCompacting the conversation…ESC[23mESC[0m"
""
"ESC[38;2;6;182;212m●ESC[39m ESC[0mESC[3mContext compacted — 97 → 2 messages.ESC[23mESC[0m"
--- resume of a compacted history ---
{"kind":"user","text":"Summary of the earlier conversation (compacted to save context):\n\n- goal: fix test"}
```

Shows every defect: two colours (periwinkle `140,170,238` vs accent cyan +
italic), `●` on all, a blank row between each, the doubled reply-cut line, and
a resumed compaction that is a user row with no marker.

## Implementation

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**A display-only field on the compaction's summary `ChatMessage` reaches every
replay path, never reaches the model, and never locks an older build out.**
(Applies to the recommended answer of Owner question 1.)

- Never sent to the model: provider mappers copy message fields one by one —
  `packages/core/src/model.ts:43-48` (the `spill` contract), verified at
  `packages/providers/src/openai-provider.ts:424` and
  `packages/providers/src/anthropic-provider.ts:503,513` (`{ role, content }`
  built explicitly, no spread).
- Precedent of display-only message fields that persist and replay:
  `durationMs`, `denialReply`, `note`, `media` in `chatMessageShape`
  (`packages/protocol/src/session.ts:80-127`); `note`/`media` are FAIL-SOFT
  (`.optional().catch(undefined)`, `:107`, `:115-120`) precisely because the
  `message` log entry is critical (`packages/protocol/src/session-log.ts:12-22`,
  `:142-148`).
- Strip schemas: an older build parsing a `message` entry drops an unknown
  field and still loads (AGENTS §7 forward compatibility) — it shows the
  summary row as today, no separator: honest degradation, no refusal.
- Every replay path carries messages: TUI resume (`resume.ts:52-57`), the live
  `history` activity (`useSessionLink.ts:325-330`), `connect`/`serve` (same
  `RemoteClient` path), mobile (`apps/mobile/src/session-feed.ts:250-258`,
  `transcript-history.ts`).

Execution's first step proves it with one test: a `ChatMessage` carrying the
new field goes through the OpenAI and Anthropic request builders and the
request body has no trace of it; and a `message` log line with the field
parses on a schema without it (strip) — red if a mapper ever spreads.

### Preconditions

- The summary message is built in ONE place, before the history is replaced:
  `compactedHistory` (`packages/agent/src/compact.ts:322-345`), called from
  `Session.compact` (`packages/agent/src/session.ts:348-372`), which replaces
  the array, then calls `onReplaced` → the daemon barrier `historyReplaced`
  (`packages/daemon/src/hosted-session.ts:3815-3860`) that logs the new segment
  (`log.replaced(..., "compact")`, `:3845-3849`) — so a field set on the
  summary before the replacement is in the persisted `message` entry.
- `/compact` is the only compaction trigger (no auto-compaction: `rg -i
  'autocompact|auto_compact'` empty; `ContextManager.needsCompaction`,
  `packages/core/src/context.ts:75-76`, has no caller that compacts).
- A context-size measurement already exists: `Session.contextUsage`
  (`packages/agent/src/session.ts:249-254`) → `{used, exact}`, bounded by
  `COUNT_TOKENS_CAP_MS` = 2 s (`packages/core/src/context.ts:11`), exact when
  the provider counts, else an estimate; exposed as `session/context`
  (`protocol/src/session.ts:1347-1370`, `hosted-session.ts:2477-2479`).
- The daemon sees each main-agent round's measured `promptTokens`
  (`hosted-session.ts:3096-3108`, the `usage` log entry). Sub-agent tokens are
  separate (`state.ts` `SubAgentProgress.tokens` "never in sessionTokens") —
  S1 pins this with a test before relying on it.
- Compaction holds the busy slot (`hosted-session.ts:3696-3741`, `assertIdle`),
  so no turn races the field being set.
- Separator rendering exists: `NoticeItem.separator` → `separatorLines`
  (`render-lines.ts:900-904`, `subtle`), used by the context reset
  (`resume.ts:15`, `:68-70`).
- Per-item row cache with a post-hoc swap: `itemRows` (`render-lines.ts:1117-1150`)
  and the `withPhase` / `offPhaseCache` swap of the head `BULLET`
  (`render-lines.ts:1097`, `:1160`) — the pattern S2 reuses to drop a
  continuation line's glyph without re-wrapping.
- The spinner slot is chosen inline in the view: `AppView.tsx:152-167`
  (`loading` → `Thinking`/`Working…`), its row reserved in `app-layout.ts:229-232`.
- `formatTokens` exists (`packages/tui/src/format.ts:20-29`, `182000 → "182k"`).
- Protocol: new optional fields are free (AGENTS §7); no new update kind and
  no new critical log type ⇒ **no `protocol.d/` note**.

### Design

#### S1 — the compaction fact (protocol → core → agent → daemon → client) · load-bearing

1. **Message field** (rec. of Q1): `ChatMessage.compacted?: { fromTokens:
   number; toTokens: number; toExact?: true }` — set ONLY on the summary user
   message of a compaction. Core type (`model.ts`, documented "display only,
   like `spill`") + protocol `chatMessageShape` entry, `z.object({...}).optional()
   .catch(undefined)` (fail-soft like `note`: a malformed value is dropped, the
   critical entry still loads). Ints, nonnegative.
2. **Core pure helpers** (shared with mobile, which cannot import `@tentacle/agent`
   — `transcript-history.ts:5-9`): `packages/core/src/compaction-view.ts`
   - `COMPACTION_SUMMARY_HEAD` = `"Summary of the earlier conversation
     (compacted to save context):"` (moved from `compact.ts:337`, which imports it).
   - `compactionOf(m: ChatMessage): { fromTokens?, toTokens?, toExact? } | null`
     — structural (`m.compacted`) first; a legacy summary (user role, content
     starts with the head, no field) → `{}` (separator without figures).
   - `compactionSeparatorText(fact)` →
     `compacted · ctx 182k → 9k` (`~9k` when `toExact` is absent, Q2),
     `compacted` alone with no figures. NO foreign variant: a compaction from
     another device reads exactly like an own one (Q6, owner override).
   - `formatTokens` moves to core (`format.ts` re-exports it, no TUI churn).
3. **Agent**: `Session.compact(signal, onReplaced, opts?: { fromTokens?: number })`
   — after `compactedHistory(...)` builds `next` and BEFORE `this.messages.length
   = 0`: `to = await this.agent.contextUsage(next, signal)` (bounded 2 s, never
   throws); `from = opts.fromTokens ?? (await this.contextUsage(signal)).used`
   ~~measured at the START~~ — **as built: measured AFTER the summary call, in
   parallel with `to` (`Promise.all`)**, on `this.messages`, which is still the
   old history until the replacement (an extra await before the summary call
   delayed it past a link drop's abort; see Execution);
   then the summary message is rebuilt with `compacted: { fromTokens, toTokens:
   to.used, ...(to.exact ? { toExact: true } : {}) }`. Abort check stays after
   the awaits (an abort still leaves the history untouched).
   `CompactResult` gains the same three optional numbers.
4. **Daemon**: `HostedSession` keeps `lastPromptTokens` from the main agent's
   `usage` events (`hosted-session.ts:3096`), reset to `undefined` at every
   history replacement (compaction, reset, clear — the figure describes a
   history that is gone); passes it as `fromTokens` (the owner's "last real
   prompt tokens" = the status bar's figure); returns the result's tokens.
5. **Protocol `session/compact` result**: `fromTokens?`, `toTokens?`,
   `toExact?: boolean` (optional ⇒ free; an older daemon omits them, the TUI
   then draws `compacted` alone).
6. **Client**: `RemoteSession.compact` (`client/src/remote-session.ts:1258-1263`)
   and the TUI `SessionController.compact` type (`tui/src/app-types.ts:127`)
   pass the optional fields through.

Q1 alternative (B), if the owner prefers a log fact: a NON-critical log entry
`compaction { fromTokens, toTokens, toExact? }` emitted right after the
`base{reason:"compact"}` (like `usage`, `session-log.ts:270-300`). Cost: the
TUI/mobile replay is built from MESSAGES, not log entries, so every replay
path (laptop resume, `connect` `session/list`+open, the live `history`
activity, mobile) would need the log facts threaded next to the messages — a
new seam per client. That is why A is recommended.

#### S2 — harness lines: one grey, glyph by kind, grouped (TUI) · contained

1. **Theme**: new token `harness` = `#b2b2b2` dark / `#4e4e4e` light (exact
   greys: chalk's 256 downgrade lands on the grey ramp 249/239, per the
   theme.ts header rule). `notice`'s only consumer is `noticeLines`
   (`render-lines.ts:909-920`; `rg 'theme.notice'`), so `notice` is REMOVED,
   not left dead. `theme.test.ts` pins both values.
2. **Kind**: `NoticeItem.level?: "warn"` (absent = info). Set to `warn` by:
   `truncated_reply` (incl. `cut`), `empty_turn`, `Compact failed: …`. Everything
   else info (job exits, `dsml_leak`, `history_repaired`, "Can't compact…",
   "Compaction cancelled — sending now.").
3. **One path for single-line harness text**: `pushNoticeItem` (`state.ts:411`)
   classifies with a pure `harnessNoticeOf(text)`: a text that is ONE line wholly
   wrapped in `_…_` becomes a `NoticeItem` (underscores stripped; `level` by an
   optional second arg); anything else (multi-line markdown: `/help`, `/model`,
   `/mcp`, `/tokens` replies) stays an `AssistantItem{notice:true}` command
   reply (scope: Q5). The 46 call sites do not change.
4. **Glyphs**: `noticeLines` draws `◇` (info) / `▲` (warn) in `harness`; `▲`
   painted `theme.warn` as the extra cue; text in `harness`; `hint` / `EXPAND_HINT`
   stay `subtle` (`render-lines.ts:913-923`). Continuation rows keep the
   two-space hang. `◇`/`▲` are single-width (not East-Asian-ambiguous in
   `string-width`; S2 pins `stringWidth("◇") === 1` and `"▲"`).
5. **Grouping — pure module** `packages/tui/src/harness-group.ts`:
   - `isHarness(item)`: `kind === "notice" && !separator`.
   - `joinsPrevious(prev, item)`: both harness ⇒ no blank row between.
   - `showsGlyph(prev, item)`: not harness-continuation, or `level` differs
     from `prev.level` ⇒ glyph; else the glyph cell becomes two spaces.
   `transcriptLines` and `layoutTranscript` BOTH call it (they must agree — the
   scroll/selection maths reads `layoutTranscript`; a parity test pins it).
   The glyph drop is a cached post-hoc swap of the head row like
   `withPhase`/`offPhaseCache`, so `itemRows`' cache key stays item identity.
6. **Truncation merge**: core `describeTruncation` gains `context.again?: true`
   → `the reply was cut at the model's output limit — asked it to continue, cut
   again; this answer is incomplete` (mockup wording). `state.ts`
   `truncated_reply`: when this turn already holds a truncation notice ending in
   `asking it to continue`, the new one REPLACES it (same index) with the
   `again` wording, instead of appending. Mobile can adopt the same core
   function in its follow-up.

#### S3 — compaction in the slot + the separator (TUI) · contained

1. **Slot view — pure module** `packages/tui/src/spinner-slot.ts`:
   `slotView({ loading, running, reasoning, compactingSince, compactedAt, now })`
   → `{ kind: "loading" } | { kind: "thinking" | "working" | "compacting",
   since } | { kind: "compacted" } | null`. Priority: loading > running >
   compacting > compacted (while `now - compactedAt < COMPACTED_SHOWN_MS` = 3000).
   `AppView` maps it: `compacting` → the existing `<Thinking label="Compacting…">`
   (same shimmer + elapsed), `compacted` → `Compacted ✓` in `subtle`.
   `app-layout.ts` reserves the row from the SAME `slotView` (no second rule),
   so the frame height stays constant.
2. **Driver**: `startCompaction` (`useTurnDriver.ts:1168`) drops the
   `_Compacting…_` push and sets `compactingSince`. `onCompactionSettled`
   (`send-now.ts:107-115`) returns `notice: null` on success plus
   `separator: compactionSeparatorText(result)`; the App appends
   `{ kind: "notice", separator: true, text }` and sets `compactedAt = now` with
   one 3 s timer to re-render; any turn start / prompt send clears
   `compactedAt` (the slot is replaced at once). Failure/cancel keep their
   notices (`▲` / `◇`).
3. **Foreign compaction**: `historyAction` (`turn-feed.ts:74-87`) returns
   `separator` instead of `notice` for a non-own compaction; the separator text
   comes from `compactionOf` on the new history's summary message, in the same
   `compactionSeparatorText` wording as an own compaction (Q6: no foreign variant);
   `FOREIGN_COMPACTED_NOTICE` goes. No slot state (this TUI never knew it ran).
4. **Resume / replace** (`resume.ts:66-73`): a user message for which
   `compactionOf` is non-null projects to a separator item, the brief kept as
   its `body` shown only when expanded (Ctrl+O), like a note (Q3);
   `separatorLines` gains the body (its `itemRows` `expandMatters` already keys
   on `body`, `render-lines.ts:1127`).

#### Follow-up task (rec. of Q4): `feat/mobile-harness-notices` · contained

Mobile already draws notices grey and has no `/compact`, so its gaps are:
separator from history (`transcript-history.ts`, using core `compactionOf` +
`compactionSeparatorText`), foreign compaction → separator
(`transcript.ts:368-372`), the merged truncation line (core
`describeTruncation{again}`), grouping (no gap between consecutive notice rows)
and `◇`/`▲` glyphs. Everything it needs from this task lands in `@tentacle/core`
in S1/S2, so the follow-up is mobile-only, DeepSeek-able, and ships after S3.
`serve`/`connect` need nothing extra: they use the same `RemoteClient` path and
the persisted field (S1).

### Files

Dependency order. **S1** (load-bearing):
1. `packages/core/src/model.ts` — `ChatMessage.compacted` (doc: display only).
2. `packages/core/src/compaction-view.ts` (new) + `packages/core/src/format.ts`
   (new, `formatTokens` moved) + `packages/core/src/index.ts` exports.
3. `packages/protocol/src/session.ts` — `chatMessageShape.compacted` (fail-soft),
   `CompactResultSchema` + 3 optional fields. `bun run protocol:bump` at merge
   regenerates `protocol.json` (no note).
4. `packages/agent/src/compact.ts` (head constant import, `CompactResult`
   fields), `packages/agent/src/session.ts` (`compact` measures + sets).
5. `packages/daemon/src/hosted-session.ts` — `lastPromptTokens`, pass/return.
6. `packages/client/src/remote-session.ts`, `packages/tui/src/app-types.ts`,
   `packages/tui/src/format.ts` (re-export).

**S2** (contained): `packages/core/src/truncation.ts` (`again`),
`packages/tui/src/theme.ts`, `packages/tui/src/harness-group.ts` (new),
`packages/tui/src/state.ts` (`level`, `harnessNoticeOf`, truncation replace),
`packages/tui/src/render-lines.ts` (`noticeLines`, `transcriptLines`,
`layoutTranscript`, glyph swap).

**S3** (contained): `packages/tui/src/spinner-slot.ts` (new),
`packages/tui/src/AppView.tsx`, `packages/tui/src/app-layout.ts`,
`packages/tui/src/useTurnDriver.ts`, `packages/tui/src/send-now.ts`,
`packages/tui/src/turn-feed.ts`, `packages/tui/src/useSessionLink.ts`,
`packages/tui/src/resume.ts`, `packages/tui/src/render-lines.ts`
(`separatorLines` body), `packages/tui/src/App.tsx` (state + timer wiring only).
Plus `changelog.d/harness-notices.changed.md`.

### Failure modes

- **Measurement slow/fails** (provider count hangs, local server busy):
  `contextUsage` is bounded at 2 s and falls back to an estimate, never throws
  (`session.ts:247-254`) → `toExact` absent, `~` shown. Worst case +2 s (+2 s
  for `from` when no turn measured yet) on a compaction that already costs a
  model call.
- **Abort during the measurement**: the existing `signal.throwIfAborted()`
  after the awaits keeps "aborted ⇒ history untouched, `Cancelled`"
  (`hosted-session.ts:3718-3722`); S1 test cancels mid-count.
- **No `lastPromptTokens`** (resumed session, no turn yet; or a reset since):
  measured from the old history at compaction start — a real count or
  estimate, never 0 (an unmeasured value is omitted, the `usage` rule,
  `session-log.ts:277-280`).
- **Older daemon** (no token fields in the result, no `compacted` field):
  separator `compacted` alone; history replay finds the legacy head → separator
  without figures. Never a crash, never a fake number.
- **Older laptop/app reading a newer log**: strip drops `compacted`; the
  summary shows as a user row (today's behaviour). Malformed value → `.catch`
  drops it, the critical entry loads.
- **Pod forges the field** (AGENTS §7: pod not trusted): display only, bounded
  ints — worst case wrong figures in a grey line; no laptop effect, no approval.
- **The summary message edited later** (`replace` on index 0/1): `compactionOf`
  reads whatever the projection holds; a replace without the field degrades to
  the legacy-head path or a plain user row. No other code keys on it.
- **`/clear` logged as `compact`** (`hosted-session.ts:3842-3849`): its history
  has no summary message ⇒ `compactionOf` null ⇒ no separator. Pinned by test.
- **Grouping mismatch** between `transcriptLines` and `layoutTranscript` ⇒
  scroll/selection off by N rows (the class AGENTS §6 warns about): both call
  `harness-group.ts`; a parity test over mixed sequences pins equality.
- **Cache staleness**: a notice's glyph depends on its neighbour; appending an
  item after it never changes it (only `prev` matters), but REPLACING the
  previous item (truncation merge, `replaceWithNotices` `state.ts:257-272`)
  can — the swap is computed per layout from `prev`, not stored in the item's
  cached rows.
- **`Compacted ✓` timer vs a new turn**: the slot's priority makes a running
  turn win immediately; the timer only triggers a re-render, a stale fire is a
  no-op (`now - compactedAt` re-checked). `/clear` and session swap clear it.
- **Foreign compaction while my own runs**: `ownCompactionsRef` counting is
  unchanged (`useSessionLink.ts:326-330`); only the action's output changes.
- **Command replies misclassified**: a multi-line or partially italic reply
  stays a command reply (`harnessNoticeOf` requires one fully wrapped line);
  table-test over the 46 call sites' shapes. Code that filters
  `AssistantItem.notice` (`turnHasAnswerText` `state.ts:241`, copy-last-
  reply) treats a `NoticeItem` the same way — S2 greps every `notice === true`
  / `.notice` reader and pins each.

### Tests

All red on current `main` first (§9), mutation-checked where noted.

**S1**
- Providers: a message with `compacted` → OpenAI and Anthropic request bodies
  carry no `compacted`/`fromTokens` key (mutation: spread the message in a
  mapper → red).
- Protocol: `ChatMessageSchema` keeps a valid `compacted`; a malformed one is
  dropped and the message still parses; a schema without the field strips it.
- Agent `Session.compact` with a fake provider + fake counter: the summary
  message carries `{fromTokens, toTokens, toExact}`; `fromTokens` from opts wins;
  without opts it is the pre-summary count; abort during the count → history
  untouched, rejects.
- Daemon: two turns with `usage` 50k then 182k → `/compact` result
  `fromTokens: 182000`; a sub-agent's usage does not move it; after a context
  reset it is `undefined` (re-measured); a `usage` of `promptTokens: 0` (a
  provider's default for a missing count) is unmeasured, never `0`. The persisted `message` entry of the
  new segment carries the field (read back through `session/log`).
- Core `compactionOf`/`compactionSeparatorText`: structural, legacy head, plain
  user message → null, `~` when estimated; no foreign variant (Q6: a second
  argument is a type error and changes nothing).

**S2**
- `harness-group.ts` table: [info, info, warn, info, separator, info] → glyph
  flags `[◇, -, ▲, ◇, n/a, ◇]`, blank rows only around the separator and
  between non-harness items.
- Parity: `layoutTranscript(items).total === wrapLines(transcriptLines(items)).length`
  and identical rows, over randomised mixes (mutation: drop the gap rule in one
  of the two → red).
- `noticeLines`: SGR shows `harness` grey for text, `◇`/`▲`; hint still `subtle`.
- `pushNoticeItem("_Can't compact…_")` → `NoticeItem`; `/help`'s multi-line
  text → `AssistantItem{notice}`.
- Truncation: re-ask then cut again → ONE notice with the merged wording;
  re-ask then success → the single `asking it to continue` line.
- ink-testing-library frame (`packages/tui/test/app.test.tsx` pattern): reply +
  three harness lines render as one block, no blank rows, no `●` on harness lines.

**S3**
- `spinner-slot.ts` table incl. the 3 s boundary (2999 shown, 3000 gone) and
  running-wins.
- App frame: `/compact` with a fake session that holds the promise → slot
  `Compacting…`, no transcript line; resolve → separator `compacted · ctx 182k
  → 9k` + slot `Compacted ✓`; after 3 s (fake clock) gone; a prompt before then
  → `Thinking…` at once. Frame height constant across all phases.
- Foreign compaction history → the SAME separator as an own compaction
  (`compacted · ctx …`, Q6), no notice. Own compaction → exactly one separator (no double from history).
- `messagesToItems` on a compacted history → separator + body (expanded only);
  legacy head → separator `compacted`; `/clear` history → no separator.
- Failure / cancel → `▲ Compact failed…` / `◇ Compaction cancelled…`.

### Owner questions

1. **Where the compaction fact lives.** (A) a display-only, fail-soft field
   `compacted` on the summary message — rides the existing critical `message`
   entry, no new log type, reaches TUI/`connect`/mobile replay for free; an
   older build drops it and shows today's row. (B) a new log entry `compaction`,
   NON-critical (display only), which every client would have to thread beside
   the messages. Neither needs a `PROTOCOL_VERSION` bump. **Rec: A** (if B:
   non-critical).
2. **"After" is an estimate unless the provider counts.** Stored once at
   compaction, not revised after the next model call (that would rewrite a
   persisted fact). **Rec: show `ctx 182k → ~9k` when estimated, no `~` when
   exact.**
3. **Resumed summary.** Today a resumed compaction shows the whole brief as a
   `›` user row the person never typed. **Rec: render it as the separator, the
   brief visible only with Ctrl+O (like a note's body).**
4. **Mobile parity.** **Rec: follow-up task `feat/mobile-harness-notices`
   (contained, DeepSeek) right after S3**; this task puts every shared piece
   (`compactionOf`, separator text, merged truncation wording, `formatTokens`)
   in `@tentacle/core`, and `serve`/`connect` need nothing more.
5. **What counts as "harness info".** **Rec: every single-line `_…_` notice and
   every `NoticeItem` (job exits, repairs, cuts); multi-line command replies
   (`/help`, `/model`, `/mcp`, `/tokens`) stay styled as command output.**
6. **Another device's compaction.** **Rec: the same separator, worded
   `compacted on another device · ctx 182k → 9k`, replacing today's notice.**

### Owner answers (2026-11-17)

Owner: "ok" to every recommendation — Q1 (A) display-only fail-soft `compacted` field on the summary message, no new log entry type; Q2 `~` when estimated, never updated later; Q3 resumed summary → separator, body on Ctrl+O; Q4 mobile = follow-up `feat/mobile-harness-notices` (shared logic in `@tentacle/core`); Q5 one-line notices + all `NoticeItem`s, multi-line command replies unchanged; Q6 foreign compaction → the SAME separator as an own compaction — **owner override 17/11: no "on another device" wording, it reads exactly as when the user compacted on this device** (not the rec). Q4 mobile follow-up: low priority, "senza fretta". Also (17/11): `Compacted ✓` shows ~3 s then disappears (already in Context). Implementation APPROVED.

## Execution

### S1 — DONE

*— claude-opus-5-5, 2026-11-17*

**Load-bearing check (first, before any code):** `packages/providers/test/compaction-fact.test.ts`
— a summary message with `compacted` → Anthropic payload and OpenAI request body
byte-identical with/without it, no `compacted`/`fromTokens` key. GREEN on the
unchanged mappers (assumption holds). The strip half: `packages/protocol/test/compaction-fact.test.ts`
"an older schema without the field strips it".

**As built, in dependency order** (each test written first, shown red on its assertion,
except the new core module whose first red was the missing export):
1. `core/src/model.ts` — `ChatMessage.compacted?: CompactionFact` (`{fromTokens, toTokens, toExact?: true}`), documented display-only.
2. `core/src/format.ts` (new, `formatTokens` moved verbatim), `core/src/compaction-view.ts` (new:
   `COMPACTION_SUMMARY_HEAD`, `compactionOf`, `compactionSeparatorText`), exported from `core/src/index.ts`;
   `tui/src/format.ts` re-exports `formatTokens`.
3. `protocol/src/session.ts` — `chatMessageShape.compacted` (ints ≥ 0, `toExact: literal(true)`,
   `.optional().catch(undefined)`); `CompactResultSchema` + `fromTokens?`, `toTokens?`, `toExact?: boolean`.
   `protocol.json` regenerated with `bun run schema:export` (+68 lines; `json-schema.test.ts` green). No `protocol.d/` note.
4. `agent/src/compact.ts` — head constant imported from core; `CompactResult` + 3 optional fields.
   `agent/src/session.ts` — `compact(signal, onReplaced, opts?: {fromTokens?})`: both sizes counted,
   then `signal.throwIfAborted()`, then the summary (the only user message of `compactedHistory`) stamped
   before the replacement; result carries the sizes.
5. `daemon/src/hosted-session.ts` — `lastPromptTokens` set from the main agent's `usage` events, cleared in
   `historyReplaced` (compact, context_reset, clear); passed as `fromTokens`; `compact()` now returns `CompactResult`.
6. `client/src/remote-session.ts`, `client/src/remote-client.ts`, `tui/src/app-types.ts` — return type `CompactResult`.
7. `changelog.d/harness-notices.changed.md` — the doc's one bullet (covers S1–S3).

**Drift from Implementation (and why):**
- **`from` measured after the summary call, in parallel with `to`** (Design S1.3 said "at the START").
  Measured at the start, the extra await pushed the summary call past a link drop's abort
  (a closing peer aborts every inbound handler, `transport/src/peer.ts:257-261`), so
  `client/test/reattach.test.ts` "compact is not re-sent after a drop" (waits for the summary's model call)
  timed out, and so did the S2 re-attach property test. `this.messages` is untouched until the replacement,
  so the after-summary count is the same old history; `Promise.all` also saves up to 2 s. Design updated in place.
- `client/src/remote-client.ts` was not in the Files list (its `compact` return type had to widen too).
- Reset test uses `/clear` rather than a context reset: one line in `historyReplaced` clears the figure for all
  three reasons; a mutation removing it turns the test red.
- Two existing assertions widened, no expectation removed: `client/test/clear-attach.test.ts:120`
  `toEqual({before, after})` → `toMatchObject` (the result now also carries the sizes); `client/test/remote.test.ts`
  compact round-trip gains `usage` on its first turn and asserts `fromTokens: 1234`, `toTokens > 0`, `toExact` absent.

**Tests added:** providers (2), protocol (5), core (6), agent (4), daemon (5: last main-agent prompt wins over a
sub-agent's `subagent_usage`; no turn → measured; after a replacement → re-measured; the new segment's persisted
`message` entry carries the fact, read back via `logRead` + `LogMessageEntrySchema`; `/clear` leaves no
`compactionOf` match), client (round-trip over RPC).

**Mutations (each red, then reverted):**
| Mutation | Red test(s) |
|---|---|
| spread `...message` in OpenAI `toWireMessage` + Anthropic user push | providers: both (2/2 fail) |
| drop `.catch(undefined)` on `compacted` | protocol: malformed-dropped + log-entry-loads (2 fail) |
| agent: drop `throwIfAborted` after the counts (first shape) | agent: abort during the after-count |
| agent: ignore `opts.fromTokens` (first shape) | agent: caller's fromTokens wins |
| agent (final shape): ignore `opts.fromTokens` AND drop `throwIfAborted` | agent: 2 fail (fromTokens, abort) |
| daemon: do not clear `lastPromptTokens` in `historyReplaced` | daemon: re-measured after a replacement |
| daemon: also take `subagent_usage` into `lastPromptTokens` | daemon: last main-agent figure |
| daemon: return only `{before, after}` | client: compact round-trip |

**Gate:** `bun run typecheck` clean · `bun run lint` clean (1997 files) · full `bun test` (once): 14526 pass,
5 skip, 3 fail — the 3 were the two re-attach tests and `clear-attach.test.ts:120` above; after the fix, the affected
files (client clear-attach/reattach/reattach.e2e, agent/, protocol/, core, daemon + providers compaction-fact,
tui app.test) → 1379 pass, 0 fail. The full suite was not re-run (token budget: once). The 5 skips: this slice adds
no skip. **Unverified:** a full `bun test` after the last fix — run `bun test 2>&1 | tail -n 15`.

### S2 — DONE

*— claude-sonnet-4-5-20250929 (executor), 2026-11-17*

**Load-bearing check (first, before any edit)** — `.tentacle/tmp/harness-notices/s2-check.ts`:
1. `stringWidth("◇") === 1`, `stringWidth("▲") === 1` (and `●` 1) — the glyph is single-width,
   so the swap cannot re-flow a row (Design S2.4's pin HOLDS).
2. Parity of the two layout paths on today's code: `layoutTranscript(items).total === 11`
   and `wrapLines(transcriptLines(items)).length === 11` over
   `[reply, notice, notice, separator, notice, user]` — the property the parity test pins
   HOLDS before the change.
3. **The plan's claim "`notice`'s only consumer is `noticeLines`" is FALSE.**
   `components/dock-tone.ts:33` paints the dock's `you → sa-1` label from `t.notice`
   (`background-list.ts:685`, `DockTone = "notice"`). So the `notice` TOKEN is KEPT
   (its styler too — `dock-tone` reads the token, and `dock-tone` is not a transcript
   path); only its use by harness lines is replaced.

**As built, in dependency order** (each unit's test written first and shown red on its
assertion; red evidence in the mutation table below):
1. `packages/tui/src/harness-group.ts` (new) — `isHarness`, `harnessLevel`,
   `joinsPrevious`, `showsGlyph` (`harness-group.test.ts`, red as a missing module, then
   red on M3).
2. `packages/tui/src/theme.ts` — new token `harness` = `#b2b2b2` dark / `#4e4e4e` light
   plus its styler; `notice` KEPT (see drift). `theme.test.ts` pins both new SGRs and the
   light/dark key-set equality; `theme-contrast.test.ts` gates the light value (4.5:1
   after the 256 downgrade) and the dark one (3:1 on `#1e1e1e`).
3. `packages/core/src/truncation.ts` — `TruncationContext.again?: boolean` and the merged
   sentence `…— asked it to continue, cut again; this answer is incomplete`
   (`truncation-again.test.ts`; `again` is ignored for `cut`, which is never re-asked).
4. `packages/tui/src/harness-text.ts` (new) — `stripInlineMarkdown` (inline code, bold,
   and markdown escapes; a LONE `*`/`_` is punctuation and stays)
   (`harness-text.test.ts`).
5. `packages/tui/src/state.ts` — `NoticeItem.level?: "warn"`; `appendNotice` takes
   `level`; `harnessNoticeOf` (ONE line wholly `_…_` → a harness line, its text
   markdown-stripped; anything else stays `AssistantItem{notice:true}`); `pushNoticeItem(
   state, text, level?)` routes through it; `turnNotices`/`saidContinueThisTurn`/
   `replaceContinueNotice` merge a second cut IN PLACE; `truncated_reply` and `empty_turn`
   are `warn` (`harness-lines.test.ts`).
6. `packages/tui/src/render-lines.ts` — `HARNESS_GLYPHS`, `headGlyph` (`◇` grey, `▲`
   amber), `noticeLines` on the harness grey with a two-space hang, `itemLines` → new
   `itemLinesAt(item, opts, glyph)`; grouping in BOTH `transcriptLines` (logical rows) and
   `layoutTranscript` (wrapped rows) from `harness-group.ts`, with the glyph dropped by a
   post-wrap cached swap (`hangCache`, the `offPhaseCache` pattern); `LaidItem.gap` so
   `sliceLaid` no longer assumes `start - 1` is always a separator
   (`harness-render.test.ts`, incl. the parity test at widths 12/20/40/80, and
   `harness-block-frame.test.tsx` for the real App frame).
7. `packages/tui/src/send-now.ts` + `useTurnDriver.ts` + the 8 `pushNotice` prop types +
   `App.tsx` — `onCompactionSettled` returns `level: "warn"` when the compaction FAILED
   (`send-now.test.ts`); `pushNotice(text, level?)` threads it.
8. `apps/mobile/src/transcript.ts` — mirrored the merge (`saidContinueThisTurn`/
   `replaceContinueNotice`), see drift.
9. `changelog.d/harness-notices.changed.md` — rewritten to describe this branch's shipped
   behaviour (the old fragment still promised the S3 slot/separator wording as done).

**Drift from Implementation (and why):**
- **The `notice` token is KEPT, not removed** (Design S2.1 said removed). Its second, live
  consumer is the dock's `you → sa-1` label (`dock-tone.ts:33`), which is not a harness
  line; deleting the token would delete that colour. Only `noticeLines` moved off it.
- **The old `●`/periwinkle contract was re-pinned, not deleted**:
  `notice-palette.test.ts` and its probe now assert the `◇`/harness-grey contract, with the
  hint/separator-subtle and hint-is-a-field pins carried over verbatim.
- **`stripInlineMarkdown` was not in the plan at all.** It was forced by two real
  regressions the plan missed: `/attach`'s usage (`_Usage: `/attach <path>`…_`) and
  `/rename`'s showed their backticks (`app-commands.test.tsx`), and `session-hop` D2
  showed `/\_ping` (the `noticeText` escape) — the `_…_` texts are markdown SOURCE, which
  used to be rendered and is now printed literally.
- **`apps/mobile/src/transcript.ts` was not in the plan's S2 file list.** The pre-existing
  shared parity test (`apps/mobile/test/transcript-parity.test.ts`, "the app's fold agrees
  with the TUI's on shared fixtures") fails the gate on its cut-reply fixture unless the
  phone folds the same merge. This is S2.6's fold only — the phone's own harness-line
  look/grouping stays the follow-up `feat/mobile-harness-notices`.
- **`LaidItem.gap`** (not in the plan): `sliceLaid` derived "a separator sits above this
  item" from `start - 1`, which is false for a joined item. The flag is the layout's own
  record of it, so both readers stay in agreement.
- **Existing assertions widened/renamed, no expectation removed**: `app.test.tsx`'s four
  `/settings` frames (`●` → `◇`, and a grouped outcome/sibling hangs two spaces),
  `truncated-reply-notice.test.tsx`'s two-notice pair → one merged line,
  `mouse-stream.test.ts`'s `LAID` fixture gains `gap`.
- **`/settings` renders as a hanging grey block** (it is an `appendNotice` with several
  lines): correct per the owner's answer 5 ("every `NoticeItem` is a harness line"), but
  it is the most visible consequence of the rule — worth the reviewer's eye.
- **Disk was full mid-task** (117 MiB); I removed Bun's download cache
  (`~/.bun/install/cache`) to write files. No repo content was touched.

**Mutations (each run, shown red, then reverted — files restored from `.tentacle/tmp/harness-notices/*.bak` and re-verified):**
| Mutation | Red test(s) |
|---|---|
| M1 `transcriptLines` keeps a blank row always | harness-render + harness-block-frame: 3 fail |
| M2 `layoutTranscript` never conceals the glyph | harness-render + harness-block-frame: 2 fail |
| M3 `showsGlyph` always `true` | harness-group: 2 fail |
| M4 `harnessNoticeOf` disabled (old `AssistantItem` path) | harness-lines + app-commands: 4 fail |
| M5 no `stripInlineMarkdown` | harness-text + harness-lines: 1 fail |
| M6 truncation never merges (always appends) | harness-lines + truncated-reply-notice: 2 fail |
| M7 `noticeLines` back to `theme.notice(BULLET)` | harness-render + notice-palette: 10 fail |

**Tests added:** `harness-group.test.ts` (5), `harness-lines.test.ts` (12),
`harness-render.test.ts` + probe (10), `harness-block-frame.test.tsx` (2),
`harness-text.test.ts` (5), `core/test/truncation-again.test.ts` (4); re-pinned
`notice-palette`, `theme`, `theme-contrast`, `send-now`, `truncated-reply-notice`,
`app`, `mouse-stream`.

**Gate:**
- `bunx tsc --noEmit` clean; `bunx tsc -p apps/mobile` clean; `bunx tsc -p apps/relay` clean.
- `bun run lint` clean — `Checked 2008 files`, 0 errors 0 warnings (matches the §6 baseline).
- full `bun test` (once, final tree): **14605 tests, 14600 pass, 0 fail, 5 skip**
  (the three known opt-ins — live-k8s, live-docker, the real-socket keepalive — plus two
  pre-existing skips; none added by S2). An earlier run of the same tree showed the one
  mobile parity failure described below; it is green in this final run.
- No `protocol.d/` note (no wire change: no schema, no new method, no new update kind);
  `packages/protocol/schema/protocol.json` untouched.

### Fix round 1

*— claude-opus-5-5, 2026-11-17* (fixes Review round 1; S1 Execution above is also opus — the "exec (deepseek)" commit title is the mislabel)

1. **MEDIUM 1 (fake `0`) — FIXED.** `daemon/src/hosted-session.ts:3104-3107`: a `usage` with
   `promptTokens <= 0` sets `lastPromptTokens = undefined` (unmeasured ⇒ `compact` measures the old
   history), so neither `0` nor an older round's stale figure reaches the separator. Test
   `daemon/test/compaction-fact.test.ts` "a usage without a prompt count (0) is unmeasured": turns 50k then 0 →
   `fromTokens: 7777`. RED on the old code: received `fromTokens: 0`.
2. **MEDIUM 2 (foreign variant) — FIXED.** `core/src/compaction-view.ts`: `compactionSeparatorText(view)` takes
   the view only; the `foreign` wording is gone. The old "foreign wording" test is replaced by "no foreign variant":
   a `// @ts-expect-error` second argument `{foreign: true}` still yields `compacted · ctx 182k → ~9k`. RED on the old
   code twice: runtime (received `compacted on another device · …`) and `tsc` (TS2578 unused directive). Doc: Design
   S3.3 and the Tests §S1 core/daemon bullets updated.

**Mutations (each red, then reverted; `git diff --stat` after = only the fix):**
| Mutation | Red |
|---|---|
| on `0` keep the previous figure (`: this.lastPromptTokens`) | daemon 0-usage test: `fromTokens: 50000` |
| accept `0` (`>= 0`) | daemon 0-usage test: `fromTokens: 0` |
| re-add a second parameter `_o?: object` to `compactionSeparatorText` | `tsc`: TS2578 at `core/test/compaction-view.test.ts:48` |

**Gate:** `bunx tsc --noEmit` clean · `bun run lint` clean (1997 files) · full `bun test` (once): 14530 pass,
5 skip, 0 fail — closes S1's "Unverified" full-suite item. The 5 skips are the same count as S1's run (no skip
added by this round).

## Review

*— claude-opus-5-5, 2026-11-17* (S1 only; fresh context, but the SAME model family as the S1 executor ⇒ shared blind spots possible)

**Verdict: REQUEST-CHANGES** (S1).

**Findings**
1. **MEDIUM — a fake `0` reaches the separator.** `packages/daemon/src/hosted-session.ts:3104` takes
   `event.usage.promptTokens` as-is, but both providers default a missing prompt count to `0`
   (`anthropic-provider.ts:336` `promptTokens ?? 0`, `openai-provider.ts:280` `prompt_tokens ?? 0`). Scenario: an
   OpenAI-compatible server that sends `usage` without `prompt_tokens` (or an Anthropic stream without
   `message_start.input_tokens`) → `lastPromptTokens = 0` → `/compact` passes `fromTokens: 0` → persisted
   `compacted.fromTokens: 0` → separator `compacted · ctx 0 → ~9k`, forever, on every replay. This contradicts the
   plan's own failure mode ("never 0 (an unmeasured value is omitted)") and the agent's existing guard
   (`agent/src/agent.ts:1957` `promptTokens > 0`). Fix: only record `> 0`; add a daemon test with a `usage` of
   `promptTokens: 0` → `fromTokens` measured.
2. **MEDIUM — the owner-rejected foreign variant was shipped and pinned.** `packages/core/src/compaction-view.ts:38-44`
   keeps `opts.foreign` → `"compacted on another device"`, and `core/test/compaction-view.test.ts:47-51` pins it,
   although Design S1.2 says "NO foreign variant … (Q6, owner override)". S3 (DeepSeek, contained) would be invited to
   wire the wording the owner rejected. Fix: drop the option and its test (Tests §S1 "`foreign`" bullet is stale too).

**Gate (re-run by reviewer):** touched files (agent/daemon/protocol/providers/core compaction tests, client
clear-attach/remote/reattach, protocol json-schema) → 196 pass, 0 fail. `bun run typecheck` clean. `bun run lint`
clean (1997 files). Full `bun test` NOT re-run by the reviewer (still the executor's open "Unverified" item).

**Mutation:** agent `session.ts` stamp removed (`built.map` → identity) → agent+daemon compaction-fact 4/9 fail;
reverted, `git status` clean.

**Attacks tried:** (a) other history mutation paths leaving `lastPromptTokens` stale — only `compact`/`clear`/
`context_reset`, all through `historyReplaced` (`:3842`): holds. (b) stamping a non-summary user message —
`compactedHistory` writes exactly one user message (system, summary, assistant/tool skill rounds): holds.
(c) model leak — providers test byte-identical bodies; field only copied explicitly: holds. (d) abort between
summary and replacement — `throwIfAborted` after `Promise.all`, history untouched: holds. (e) zero/missing usage →
finding 1. (f) design vs code on Q6 → finding 2. Single-broker / RPC-peer / persistence invariants: untouched
(no lock, no await on the peer, field rides the existing critical `message` entry fail-soft).

**Executor behaviour:** honest Execution (drift on `from` timing explained and reflected in Design; unverified full
suite stated). Commit is titled "exec (deepseek)" while Execution is signed opus — reconcile the signature.

### Round 2

*— claude-opus-5-5, 2026-11-17* (fresh context, same model family as the executor)

**Verdict: PASS** (S1).
- F1 fixed: `hosted-session.ts:3106-3107` stores `promptTokens > 0`, else `undefined`. New daemon test (`[50k, 0]` → measured 7777).
  Mutation A (guard removed) → 1 fail; mutation B (a 0 keeps the older 50k) → 1 fail; both reverted.
- F2 fixed: `compaction-view.ts:41` takes only the view; no `foreign` caller left in `packages/` (the TUI's
  `FOREIGN_COMPACTED_NOTICE` is S3 scope). Mutation C (foreign wording re-added) → 1 fail; reverted, tree clean.
- Gate: touched files 114 pass / 0 fail; `bun run typecheck` clean; `bun run lint` clean (1997 files). Full `bun test`
  not re-run by the reviewer. No regression found in the round-2 diff.

## Review

*— claude-opus-5-5, 2026-11-17* (S2 only, `git diff main...HEAD`; fresh context. The executor signature reads
claude-sonnet-4-5 but the commit says "exec (deepseek)" — reconcile)

**Verdict: REQUEST-CHANGES** (S2).

**Findings**
1. **MEDIUM — a later, separate cut in the same turn rewrites the FIRST notice, far up the transcript.**
   `packages/tui/src/state.ts:679-687` (`again = saidContinueThisTurn(state)`) and `replaceContinueNotice` (`:268-279`)
   treat ANY truncation after a "…asking it to continue" line in the turn as "the re-ask was cut again". But the
   re-ask budget is per TURN (`agent.ts:1426`, `MAX_TRUNCATION_REASKS = 1`), and the re-ask can go on to run tools and
   further rounds. Repro (`.tentacle/tmp/harness-notices/rev-s2-later-cut.ts`): [user, reply, cut (re-ask), reply,
   tool, reply] then a later `truncated_reply{reason:"length", retrying:false}` (e.g. the refused cut tool call,
   `agent.ts:1620`) → item 2, ABOVE the tool row, becomes "…asked it to continue, cut again; this answer is
   incomplete"; nothing is appended at the turn's end. With `reason:"cut"` (`agent.ts:1609`) the first fact
   (output limit + re-ask) is overwritten by "the model's stream was cut before it finished" — first fact lost,
   second misplaced. On `main` that second sentence was appended at the end. `apps/mobile/src/transcript.ts:458-466`
   mirrors the same bug. Fix: merge only when the continue notice is the turn's last notice AND nothing but the
   re-ask's own reply follows it (or the loop flags the re-ask's cut explicitly), and never merge a `cut` reason;
   add a test for the later-round cut on both TUI and phone.

**Gate (re-run by reviewer):** touched test files + `app-commands` + mobile `transcript-parity` → 272 pass, 0 fail
(15 files). `bun run typecheck` clean. `bun run lint` clean (2008 files). Full `bun test` not re-run.

**Mutation (each red, then reverted; `git status` clean):** `layoutTranscript` gap ignores `joinsPrevious` →
2 fail (PARITY, App frame). `sliceLaid` back to "a separator above every non-first item" → 2 fail. Executor's M1–M7
table not re-run.

**Attacks tried:** (a) parity of the two layout paths / `sliceLaid` gap — holds, mutation-pinned. (b) glyph cache
staleness: `hangCache` keyed on the item's row array, level is item-derived, `prev` recomputed per layout — holds.
(c) other `kind === "notice"` readers now seeing ex-`AssistantItem` lines (`resetHistory` host filter,
`transcriptToMarkdown`, job dedupe, `turnHasAnswerText`) — no wrong state found. (d) truncation merge across rounds
→ finding 1. §7 invariants: pure-module split respected (`harness-group.ts`, `harness-text.ts`); no wire,
persistence or terminal-IO change.

**Executor behaviour:** honest, well-documented drift (`notice` token kept for `dock-tone.ts:33`; `stripInlineMarkdown`
added for real regressions; mobile mirror forced by the parity test). The happy path is well tested; the merge rule's
scope was not challenged beyond the immediate re-ask.
