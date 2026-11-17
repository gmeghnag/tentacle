# feat/harness-notices — one grey voice for harness lines, grouped; compaction as a slot + separator

> **Status:** implementation (awaiting owner answers + approval)
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
   - `compactionSeparatorText(fact, opts?: { foreign?: boolean })` →
     `compacted · ctx 182k → 9k` (`~9k` when `toExact` is absent, Q2),
     `compacted` alone with no figures; `foreign` → `compacted on another device
     · …` (Q6).
   - `formatTokens` moves to core (`format.ts` re-exports it, no TUI churn).
3. **Agent**: `Session.compact(signal, onReplaced, opts?: { fromTokens?: number })`
   — after `compactedHistory(...)` builds `next` and BEFORE `this.messages.length
   = 0`: `to = await this.agent.contextUsage(next, signal)` (bounded 2 s, never
   throws); `from = opts.fromTokens ?? (await this.contextUsage(signal)).used`
   measured at the START (before the summary call, so it is the old history);
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
   comes from `compactionOf` on the new history's summary message (`foreign`);
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
  reset it is `undefined` (re-measured). The persisted `message` entry of the
  new segment carries the field (read back through `session/log`).
- Core `compactionOf`/`compactionSeparatorText`: structural, legacy head, plain
  user message → null, `~` when estimated, `foreign`.

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
- Foreign compaction history → separator `compacted on another device · …`,
  no notice. Own compaction → exactly one separator (no double from history).
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

## Execution

*— <model-id>, <YYYY-MM-DD>*

## Review

*— <model-id>, <YYYY-MM-DD>*
