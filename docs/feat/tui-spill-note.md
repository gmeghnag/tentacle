# feat/tui-spill-note — A spilled tool result shows a short note, not the model's banner

> **Status:** executed 2026-10-25, awaiting the fresh-context Review — plan APPROVED by the owner 2026-10-25 (Q1–Q5 answered, see *Owner decisions*)
> **Branch:** `feat/tui-spill-note`
> Type: feat · Size: L · Blast: load-bearing · Suited: strong model (Opus) executes; mandatory fresh-context Review that red-teams the on-disk record rule (AGENTS §7 "On-disk records are versioned separately") and the forward-compat rule. (TODO.md guessed S–M · cross-module; re-sized because surviving resume needs a persisted-format change: the laptop store and the daemon record. If the owner prefers, split per Q5.)

## Context

*— claude-opus-5-5, 2026-10-25*

**Problem.** A tool result larger than `tools.maxInlineOutputChars` (default
16000, `packages/config/src/defaults.ts:29`) is spilled by `spillLargeOutput`
(`packages/agent/src/result-pipeline.ts:77-99`). The full output goes to a
file, and the result's `content` becomes a banner meant for the model plus a
head/tail preview:

```
[large fs_read output: full output (40800 chars) saved to .tentacle/tool-output/fs_read-c1.txt — read it selectively with fs_read (offset/limit) or grep; do NOT read it whole]
<600 chars of head>
…[39600 characters omitted]…
<600 chars of tail>
```

(`result-pipeline.ts:85-97`). Today the TUI shows this text as it is
(`packages/tui/src/render-lines.ts:335-348`), because the spill exists ONLY as
text. `ToolResult` has no structured spill fact (`packages/core/src/tool.ts:30-44`).

**Owner-approved design (TODO.md:828-848, verbatim UI strings):**
- The model keeps the banner unchanged.
- The daemon flags the result structurally (an additive field: spilled, chars,
  path, and the preview parts). The TUI NEVER parses the banner text and never
  guesses from the shape of the text. This must also hold on resume and reload
  from history.
- Normal view: a grey line `40.8k chars · too large, the model reads it in parts`,
  then the head/tail preview (syntax-coloured as in `tui-read-highlight` for
  `fs_read`), with the usual `… +N more lines · ctrl+o to expand`.
- ctrl+o: the grey line, then `saved to <path>` (in a pod:
  `saved in the pod to <path>`), then the full head, `… N chars omitted …`, the
  full tail. The path is shown ONLY in ctrl+o.
- The same for every tool that spills (shell too), not only `fs_read`.
- The "could not be saved" case (no path) says so, without a path.

**Repro** (2026-10-25, `.tentacle/tmp/tui-spill-note-plan/repro.ts`, run with
`bun` from the repo root checkout. Workspace packages resolve from there, so
re-run it on `main` before any edit):

```ts
import { parseSessionRecord, spillLargeOutput } from "@tentacle/agent";
import { ChatMessageSchema, SessionUpdateSchema } from "@tentacle/protocol";

// 1. today's spill: the banner is the only signal, inside `content`
const spill = spillLargeOutput({ maxInlineChars: 16000 });
const out = await spill(
  { content: "x".repeat(40_800) },
  {
    toolName: "fs_read",
    toolCallId: "c1",
    writeSpill: async () => ".tentacle/tool-output/fs_read-c1.txt",
  },
);
console.log("1 keys:", Object.keys(out), "| first line:", out.content.split("\n")[0]);

// 2. an older client parses a tool_call_update carrying an extra `spill`
const upd = SessionUpdateSchema.safeParse({
  type: "tool_call_update",
  toolCallId: "c1",
  status: "completed",
  content: [{ type: "text", text: "hi" }],
  spill: { chars: 40800 },
});
console.log("2 update ok:", upd.success, "| spill kept:", upd.success && "spill" in upd.data);

// 3. the wire ChatMessageSchema (snapshot / open{messages}) with an extra key
const msg = ChatMessageSchema.safeParse({ role: "tool", content: "x", toolCallId: "c1", spill: {} });
console.log("3 message ok:", msg.success, "| spill kept:", msg.success && "spill" in msg.data);

// 4. the laptop store (and daemon record) parser with an extra message key
const rec = parseSessionRecord(
  {
    id: "u1", cwd: "/w", model: "m", title: "t", createdAt: 1, updatedAt: 1,
    messages: [{ role: "tool", content: "x", toolCallId: "c1", spill: {} }],
    spills: { c1: {} },
  },
  "u1",
);
console.log("4 record:", JSON.stringify(rec.ok ? "ok" : rec.reason));

// 5. extra TOP-LEVEL key only
const rec2 = parseSessionRecord(
  { id: "u1", cwd: "/w", model: "m", title: "t", createdAt: 1, updatedAt: 1, messages: [], spills: { c1: {} } },
  "u1",
);
console.log("5 record top-level extra:", rec2.ok ? "ok (kept)" : rec2.reason);
```

Output:

```
1 keys: [ "content" ] | first line: [large fs_read output: full output (40800 chars) saved to .tentacle/tool-output/fs_read-c1.txt — read it selectively with fs_read (offset/limit) or grep; do NOT read it whole]
2 update ok: true | spill kept: false
3 message ok: true | spill kept: false
4 record: "message 0 has unknown key \"spill\""
5 record top-level extra: ok (kept)
```

What it shows: (1) the spill is text-only today. (2)(3) An older peer strips
a new optional field and still accepts the frame: the wire change needs no
bump. (4) The laptop store's per-message parser is strict: an older build
refuses a record that has a new message key, and refuses it loudly. (5)
Top-level extras pass (they are the basis of the rejected option B).

## Implementation

*— claude-opus-5-5, 2026-10-25*

### Load-bearing assumption

**The spill fact can ride WITH the tool result on every path from which the
TUI builds a tool row. Every one of those paths carries the objects as they
are, so the fact cannot be lost on the way. Only the model-facing mappers copy
field by field, so the model never sees it.**

The TUI builds a tool row from exactly two sources:
- **Live:** the `tool_result` AgentEvent's `ToolResult`
  (`packages/tui/src/state.ts:238-266`). In-process it comes straight from the
  agent (`agent.ts:762`). Over RPC it travels `eventToUpdate` →
  `tool_call_update` → `updateToEvent` (`packages/daemon/src/mapping.ts:203-209`,
  `packages/client/src/mapping.ts:169-175`).
- **History:** `messagesToItems(ChatMessage[])` (`packages/tui/src/resume.ts:9-46`),
  used by `--resume` (`packages/tui/src/run.tsx:66-69`, fed from the laptop
  record, `packages/cli/src/tui-sessions.ts:130`) and by a resync's
  `history_reset` (`packages/tui/src/state.ts:371-378`, fed from
  `session/snapshot`, `packages/client/src/remote-session.ts:593`).

The history paths pass messages through as they are, with no field-by-field
copy:
- `Session.snapshot` is `[...this.messages]` (`packages/agent/src/session.ts:62`).
- `snapshotPage` slices `this.session.messages` (`packages/daemon/src/hosted-session.ts:832`).
- The daemon record holds `state.messages` (`packages/daemon/src/persisted-session.ts:105`).
- The laptop record holds `snapshot.messages` (`packages/agent/src/session-store.ts:111`).

The only filters are the parsers: the wire `ChatMessageSchema`
(`packages/protocol/src/session.ts:31-36`, which strips: repro 3) and the
store's `messageProblem` (`session-store.ts:211-252`, which is strict:
repro 4). Both get the field.

The model-facing mappers copy field by field, so a new `ChatMessage` field
never reaches a provider:
- OpenAI `toWireMessage` (`packages/providers/src/openai-provider.ts:217-229`).
- Anthropic (`packages/providers/src/anthropic-provider.ts:301-324`).
- The pod model tunnel `toWireRequest` (`packages/daemon/src/proxy-model.ts:47-58`).
- Hooks (`packages/agent/src/hooks.ts:710`).

### Preconditions

- **Spill runs last, after redaction.** Order: `redactSecrets` → `runResultHooks`
  → dedup → tabulate → large output (`packages/cli/src/wiring.ts:184-187, 230-236`).
  So `head`/`tail` are cut from the already-redacted content: the structured
  field never carries a secret the model text did not. Nothing transforms
  the result after spill, so the field and `content` cannot diverge.
- **Spill and summarise are exclusive** (`wiring.ts:188-193`): no result goes
  through both. A `skill` result is never spilled (`wiring.ts:194-196`).
- **Every tool result passes `transformResult`.** Model calls go through
  `agent.ts:758-763`. User skill activations go through `agent.ts:801-816`
  and `agent.ts:315`. MCP tools are ordinary registry tools on the same path
  (`runTool`, `agent.ts:889-896`). A sub-agent gets the same transforms
  (`packages/agent/src/subagent.ts:173`). `shell_output` (background job
  output) is a normal tool. The background-exit note is a `user` message,
  never spilled (`agent.ts:839-842`).
- **Wire rules:** payload schemas strip unknown fields (AGENTS §7 forward
  compat; repro 2–3). `tool_call_update` is `display` (`packages/protocol/src/updates.ts:224`).
  `ToolCallUpdateSchema` is a plain `z.object` (`updates.ts:49-54`).
  `PROTOCOL_VERSION = 11` (`packages/protocol/src/version.ts:7`).
- **On-disk rules:** the laptop store is strict per message (repro 4) and has
  no version field (`session-store.ts:21-37`). The parity of the store and wire
  message shapes is pinned by `packages/cli/test/session-resume.test.ts:199-236`.
  The daemon record is `DAEMON_RECORD_VERSION = 4`, reads `[1,2,3,4]`, refuses
  any other version and leaves the file untouched
  (`persisted-session.ts:27-29, 183-200`). Pod daemons never persist (AGENTS §7).
- **Runtime kind is known only in `cli`:** `runPodTui` is the single TUI
  entry for pod `run`/`attach` (`packages/cli/src/main.ts:458-492`). The worker
  (`main.ts:620-649`), in-process (`main.ts:656-701`) and `connect`
  (`packages/cli/src/connect.ts:123`) paths are separate calls. The TUI has
  no runtime-kind prop today (`packages/tui/src/run.tsx:17-40`,
  `App.tsx:167-205`).
- **Existing render seams:**
  - `toolLines` collapses any body longer than the threshold into
    `preview` lines + `… +N more lines · ctrl+o to expand`
    (`render-lines.ts:410-429`). `toolBody` gets `headLimit === undefined`
    exactly when expanded (`render-lines.ts:420`).
  - `fs_read` colouring is `highlightRead(cleanReadText(text), path, "dark", limit)`,
    which returns `undefined` → plain (`packages/tui/src/read-highlight.ts:171-215`).
    It is memoised per item in `readHlCache` (`render-lines.ts:290-308`).
  - The row cache is keyed by item identity + expand/width/threshold/preview
    (`render-lines.ts:532-556`).
  - Pod-supplied display text goes through `oneLine` (`packages/tui/src/commands.ts:44-54`).
  - The `k` formatter is `formatTokens` (`packages/tui/src/format.ts:8-29`).

### Design

**1. One shape, one source of truth: `ToolResultSpill`** (`@tentacle/core`, `tool.ts`).

```ts
/** A result too large for the context (`spillLargeOutput`): what the TUI shows instead of the model's banner. */
export interface ToolResultSpill {
  /** Length of the full output (`String.length`). */
  readonly chars: number;
  /** Where the full output was saved (workspace-relative); absent = it could not be written. */
  readonly path?: string;
  /** The preview's first part, and its last part ("" when nothing was omitted). */
  readonly head: string;
  readonly tail: string;
  /** Characters between `head` and `tail` (0: `head` is the whole output). */
  readonly omitted: number;
}
```

- `ToolResult.spill?: ToolResultSpill` (live path).
- `ChatMessage.spill?: ToolResultSpill` (history path; only on `role: "tool"`
  messages; `packages/core/src/model.ts:27-34`).

`head`/`tail` are DATA, the same `slice`s that build the preview
(`result-pipeline.ts:87-89`). The TUI never splits `content` at the
`…[N characters omitted]…` marker (question 4).

**2. Agent (producer).**
- `spillLargeOutput` returns `{ ...result, content: <unchanged banner+preview>, spill: { chars, head, tail, omitted, ...(path ? { path } : {}) } }`.
  `content` stays byte-identical to today. When `omitted === 0`, `head` is the
  whole content and `tail` is `""`, matching `result-pipeline.ts:90`.
- `summarizeLargeOutput` is NOT flagged (Q4): its result is a summary, not a
  head/tail preview, and the owner's strings do not fit it. It stays as today:
  off by default (`defaults.ts:33`), with the banner shown.
- `agent.ts:763` and `agent.ts:816` push the tool message with
  `...(result.spill ? { spill: result.spill } : {})`. The cancel/synthetic
  pushes (`agent.ts:731-735`) never spill and are unchanged.

**3. Protocol (one shared schema, both ends).**
- New `ToolResultSpillSchema` in `packages/protocol/src/spill.ts`:
  `z.object({ chars: z.number().int().nonnegative(), path: z.string().min(1).max(4096).optional(), head: z.string(), tail: z.string(), omitted: z.number().int().nonnegative() })`.
  It is a strip schema, never `.strict()`. Export it from the index.
- `ToolCallUpdateSchema.spill: ToolResultSpillSchema.optional()` (`updates.ts:49-54`).
- `ChatMessageSchema.spill: ToolResultSpillSchema.optional()` (`session.ts:31-36`).
  This carries it through `session/snapshot` (`session.ts:353`) and
  `session/open{messages}` seeding (`session.ts:416`).
- **No `PROTOCOL_VERSION` bump.** Both are optional additive fields on strip
  schemas. An older client drops them and keeps a valid frame (repro 2–3),
  then renders today's banner. An older daemon never sends them. No new
  update type, so `UPDATE_CLASS` is unchanged (`tool_call_update` stays
  `display`) and there is no new union member or reverse mapping. A
  malformed `spill` from a newer daemon makes a known update malformed →
  `classifyUpdate` error (`packages/client/src/mapping.ts:57-58`). That is
  loud by design, and the forward-compat rule wants it ("known fields keep
  full validation").
- Regenerate `packages/protocol/schema/protocol.json` (`bun run schema:export`;
  its staleness is pinned by `packages/protocol/test/json-schema.test.ts:14,40`).

**4. Daemon.**
- `eventToUpdate` `tool_result` → add `...(event.result.spill ? { spill: event.result.spill } : {})`
  (`daemon/src/mapping.ts:203-209`). The replay ring stores the update as it
  is, so a reattach replay keeps it.
- **Record v5** (`persisted-session.ts:27-29`): `DAEMON_RECORD_VERSION = 5`,
  `READABLE_VERSIONS = [1,2,3,4,5]`. A v4 record reads as a v5 record with no
  spills. A v4 daemon refuses a v5 record and never overwrites it
  (`persisted-session.ts:183-200`): with "unsupported record version 5" when the
  record holds no spill, and earlier, at the strict store parser, with
  `message N has unknown key "spill"` when it does (`cli/src/serve.ts:214-224`;
  corrected after Review finding 1). Without the bump, a v4 daemon
  would still refuse a v5 file through the strict message check (repro 4), but
  with a misleading reason. The bump keeps the rule "the shape changed → the
  version says so" (AGENTS §7). Extend the version comment
  (`persisted-session.ts:14-26`): "5: a tool message may carry `spill`
  (docs/feat/tui-spill-note.md)".

**5. Laptop store (`packages/agent/src/session-store.ts:210-252`).**
`MESSAGE_KEYS` += `"spill"`. `messageProblem` validates `spill` when present:
an object with exactly `chars`/`head`/`tail`/`omitted` and optional `path`;
numbers are non-negative integers, strings are strings, `path` is non-empty.
Otherwise → `"has a malformed spill"`. The store accepts it on any role, to
keep exact parity with the wire schema (the pinned parity test).
`messagesToItems` reads it only on `tool`. An older build refuses a record
that holds a spill, loudly: `message N has unknown key "spill"` (repro 4). It
is never half-loaded. **This is the owner decision Q1.**

**6. Client.** `toolResultFromContent` gains the update's `spill`:
`updateToEvent` `tool_call_update` → `result: { ...toolResultFromContent(...), ...(update.spill ? { spill: update.spill } : {}) }`
(`client/src/mapping.ts:169-175`). It is never derived from `content`.

**7. CLI: the pod fact** (question 3).
- `TuiOptions.daemonInPod?: boolean` (`run.tsx:17-40`) → `AppProps.daemonInPod`
  (`App.tsx:167-205`) → `RenderOptions.spillInPod?: boolean` (`render-lines.ts:22-31`),
  passed at both `App.tsx:474` and `App.tsx:547`.
- Set `daemonInPod: true` ONLY in `runPodTui` (`main.ts:474-487`). This is
  the runtime the laptop itself started, a fact and not a guess. The worker,
  in-process and `connect` paths leave it unset → `saved to <path>`.
- `connect` reaches a `serve` daemon. AGENTS §7 treats `serve` as the user's
  own host, so `saved to` is the right string (known limit: on a `serve` on
  another of the user's machines, the path is relative to that host).
- It is constant for an App's lifetime, so the row cache needs no new key.
  Say so in a comment on the option.

**8. TUI: pure view-model + dumb render** (question 5, AGENTS §7 "logic lives
in pure modules").
- `ToolItem.spill?: ToolResultSpill` (`state.ts:52-66`). Set it in `applyEvent`
  `tool_result` (`state.ts:251-258`, like `detail`/`hook`) and in
  `messagesToItems` for a `tool` message carrying it (`resume.ts:37-39`). A
  resync goes through `messagesToItems` (`state.ts:372`), so it is covered too.
- `format.ts`: `formatChars(n)`: below 1000 → `"999"`, otherwise one decimal
  in `k`/`M` with `.0` dropped (`40800 → "40.8k"`, `16000 → "16k"`,
  `1_234_567 → "1.2M"`). This matches the owner's `40.8k` example. Note that
  `formatTokens` gives `41k` (`format.ts:13-16`): Q3.
- **New `packages/tui/src/spill-view.ts`** (React-free, unit-tested). It
  returns plain strings and no colours:

  ```ts
  export interface SpillView {
    readonly note: string;          // "40.8k chars · too large, the model reads it in parts"
    readonly where?: string;        // expanded only: "saved to <p>" | "saved in the pod to <p>"
    readonly head: string;          // spill.head, CRLF/CR/NUL cleaned (cleanReadText)
    readonly omitted?: string;      // "… 39.6k chars omitted …" — absent when omitted === 0
    readonly tail: string;          // "" when omitted === 0
  }
  export function spillView(spill: ToolResultSpill, o: { expanded: boolean; inPod: boolean }): SpillView;
  ```

  - `note` with a path: `${formatChars(chars)} chars · too large, the model reads it in parts`.
  - `note` without a path: `${formatChars(chars)} chars · too large, could not be saved — the model sees only this preview` (Q2). There is no `where` line, and it is never a path.
  - `where`: present only when `expanded && path`. The path goes through
    `oneLine` (pod-supplied text, `commands.ts:44-54`). `inPod` picks
    `saved in the pod to `, otherwise `saved to `.
  - `omitted`: `… ${formatChars(omitted)} chars omitted …` (Q3 covers this
    number too).
- **`render-lines.ts` (presentation only).** A new branch at the top of the
  result rendering in `plainToolBody`, placed after the diff and running
  checks and before the plain `resultText` rendering (`render-lines.ts:332-348`):
  `if (tool.spill) return spillBody(tool, view, width)`.
  - The order is `note` (subtle), `where` (subtle, expanded only), the head
    lines, `omitted` (subtle), the tail lines.
  - Head and tail lines: for `fs_read` with status ≠ error,
    `highlightRead(head, path)` and `highlightRead(tail, path)` are each
    highlighted on its own, because they are discontiguous. Each falls back
    to plain when it returns `undefined`. Otherwise they render
    `theme.error`/`theme.subtle` exactly like `render-lines.ts:342-347`.
  - Memoise the two coloured parts per item in a `WeakMap<ToolItem, …>`,
    like `readHlCache` (`render-lines.ts:290`). The parts are small (600 +
    600 chars by default, `result-pipeline.ts:79`), so there is no `limit`
    slot.
  - A sub-agent (`tool.sub`, `render-lines.ts:315-331`) whose report spilled
    renders the tree, then `""`, then the spill lines instead of the raw
    `resultText`.
  - A `modified` hook keeps the body (`render-lines.ts:281`), so the spill
    view shows under the hook line. A `blocked` call is never spilled.
  - **Collapse is unchanged** (`toolLines`, `render-lines.ts:418-426`). The
    normal view shows the note + the first head lines +
    `… +N more lines · ctrl+o to expand`. ctrl+o shows all of it plus the
    `where` line. The path appears only in ctrl+o because `where` exists only
    when expanded.
- `/save` (`transcriptToMarkdown`, `commands.ts:305-328`) keeps exporting
  `resultText`, which is what the model saw. That is out of scope. Note it in
  Review as a possible follow-up.

**Seams for later tasks.** Task 6 `tui-foreign-turns` and the mobile app read
the same `tool_call_update.spill` and `ChatMessage.spill`. A mobile renderer
only needs `ToolResultSpillSchema` (strip, in `@tentacle/protocol`) and can
reuse the wording from `spill-view.ts`.

#### Option comparison for persistence (question 2)

| | A. `spill` on the tool `ChatMessage` (**recommended**) | B. top-level side map `spills{callId→…}` in records + `snapshot.spills` + `open.spills` | C. not persisted |
|---|---|---|---|
| Survives `--resume`, resync, reattach, daemon restart | yes: rides with the message through every as-is path | yes, if every path also carries the map | no: resume shows the raw banner (violates TODO.md:838-839) |
| Compaction | free: dropped with the message (`compact.ts:228-248`) | must prune the map by hand | — |
| Older laptop build | refuses a record with a spill **loudly** (repro 4) | reads it (repro 5) but **silently drops** the map at its next save | — |
| Older daemon | refuses v5, file untouched | needs a v5 bump anyway | — |
| New surface | 1 optional field, wire + 2 parsers | a map in agent `Session`, 2 records, 2 wire fields, pruning | none |

A is the only option that keeps one source of truth and never guesses. Its
price is a persisted-format change that an older build refuses. The
precedent is the chosen-title change (`session-store.ts:28-34`), where the
owner accepted a loud refusal. B trades the loud refusal for silent loss
and twice the code. Recommend A (Q1).

### Files (dependency order)

1. `packages/core/src/tool.ts` (`ToolResultSpill`, `ToolResult.spill`),
   `packages/core/src/model.ts` (`ChatMessage.spill`).
2. `packages/protocol/src/spill.ts` (new), `src/updates.ts`, `src/session.ts`,
   `src/index.ts`, `schema/protocol.json` (regenerated).
3. `packages/agent/src/result-pipeline.ts`, `src/agent.ts` (two pushes),
   `src/session-store.ts` (`MESSAGE_KEYS`, `messageProblem`).
4. `packages/daemon/src/mapping.ts`, `src/persisted-session.ts` (v5).
5. `packages/client/src/mapping.ts`.
6. `packages/cli/src/main.ts` (`runPodTui` only).
7. `packages/tui/src/format.ts`, `src/spill-view.ts` (new), `src/state.ts`,
   `src/resume.ts`, `src/render-lines.ts`, `src/run.tsx`, `src/App.tsx`
   (prop → render options only).
8. `docs/feat/tui-spill-note.md` (this doc), `TODO.md` entry.

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| No path (`writeSpill` → null, `agent.ts:877-879`) | `spill` without `path` → the "could not be saved" note, no `where` line, never a path. The model text is unchanged (`result-pipeline.ts:95`). |
| `omitted === 0` (`maxInlineChars` < preview size) | `head` = the whole content, `tail` = "", no omitted line. |
| Older daemon (no field) | No `spill` → today's raw banner, rendered as plain text. Nothing parses it. Pinned by a test. |
| Older client / older mobile | Strips `spill` (repro 2–3) → today's banner. No bump. |
| New client seeds an older daemon (`open{messages}` with `spill`) | The older daemon strips it, so its history and later snapshots lack it. The laptop re-persists from that snapshot → the affected rows fall back to the banner. A cosmetic degradation that converges to the banner. Never wrong, never parsed. |
| Older laptop build `--resume` of a newer record | Loud refusal: `message N has unknown key "spill"` (repro 4). Never half-loaded (Q1). |
| Older daemon start with a v5 record | Skipped, never overwritten: "unsupported record version 5" (no spill) or `unknown key "spill"` from the store parser, which runs first (`cli/src/serve.ts:214-224`). |
| Malformed `spill` on the wire (a buggy or hostile pod) | A known update fails validation → the turn fails loudly (`client/mapping.ts:57-58`). In a snapshot, the page parse fails (a loud resync error). Never rendered half. |
| Pod-supplied path or preview text | The path goes through `oneLine` and is capped at 4096 by the schema. `head`/`tail` render exactly like today's pod-supplied `content`, no new exposure. The pod is not trusted, but a spill is display-only (it grants nothing on the laptop: AGENTS §7 "a pod is not trusted"). |
| Secrets | `head`/`tail` are cut AFTER `redactSecrets` (`wiring.ts:230-236`), so they are never less redacted than `content`. Pinned by a test. |
| Sub-agent (`agent_task`) | The child's own spills stay in the child (only labels stream, `daemon/mapping.ts:223-233`). The parent's `agent_task` report, if spilled, renders through the spill view under the tree. |
| MCP tool, `shell`, `shell_output` (background job output) | The same `transformResult` path → flagged the same way ("every tool that spills"). The background-exit note is a `user` message, not a tool result → untouched. |
| Compaction | Tool messages are replaced by the summary (`compact.ts:228-248`), so their spill goes with them. Carried-over `skill` rounds are never spilled (`wiring.ts:196`). |
| Summarised (`summarizeLargeOutput`) | Not flagged → today's text (Q4). A result can never be both summarised and spilled by `spillLargeOutput`, because the two transforms are exclusive (`wiring.ts:188-193`). |
| `isError` and spilled (huge stderr) | The note is grey and the head/tail are `theme.error`. No syntax colour (the same rule as `render-lines.ts:336`). |
| A tool message with `spill` but no matching call (truncated history) | `resume.ts:40-42` shows a notice with `content`, today's behaviour. Acceptable: there is no row to attach the view to. |
| A transform added after spill in the future | `content` and `spill` could diverge. A test pins "large output is the last transform" (in `wiring`), so a reorder fails CI. |

### Tests

Red first: each test below fails on `main` (no field, so `undefined`), then
goes green. Each **key** test gets a mutation check (break the line → the
test fails → revert). Narrow files while iterating; then `bun run check`.

1. `packages/agent/test/result-pipeline.test.ts`:
   - The spill sets `spill = { chars: 40800, path, head: 600 chars, tail: 600 chars, omitted: 39600 }`, and `content` is byte-identical to the current banner + preview (the model is unchanged).
   - With no path: there is no `path` key.
   - When `omitted` is 0: `tail` is `""`.
   - Under the threshold: no `spill`.
   - `summarizeLargeOutput` sets no `spill`.
   - *Mutation:* drop `path` from the spill object → the first test fails.
2. `packages/agent/test/agent-spill.test.ts`: the `tool_result` event AND the
   pushed `role: "tool"` message both carry `spill` (`agent.ts:763`), and so
   does a user skill round's push (`agent.ts:816`), using a non-exempt result
   for this test. *Mutation:* remove the spread at `agent.ts:763` → the
   message assertion fails.
3. Pipeline order (`packages/cli/test/…` at the existing wiring test, or a new
   `wiring-order.test.ts`): with `redactSecrets` on, a secret in the first
   600 chars is masked in `spill.head`; large output is the last transform.
4. `packages/protocol/test/updates.test.ts` + `session.test.ts`:
   - Valid `spill` is kept on `tool_call_update` and on `ChatMessageSchema`.
   - A negative `chars`, an empty `path`, or a `path` over 4096 → invalid.
   - `forward-compat.test.ts`: a frame with an unknown extra field inside
     `spill` still parses (strip).
5. `packages/daemon/test/mapping.test.ts`: `eventToUpdate` puts `spill` on
   `tool_call_update` and omits the key when there is none. *Mutation:* drop
   the spread → the test fails.
6. `packages/client/test/mapping.test.ts`:
   - `updateToEvent` carries `spill` into `result.spill`.
   - An update with banner text and NO `spill` gives a result with no
     `spill` (this pins "never parsed").
7. `packages/agent/test/session-store.test.ts`:
   - A record with a spilled tool message round-trips save → load.
   - A malformed spill (a missing `head`, a string `chars`, an extra key) is
     refused with "has a malformed spill".
   - Update the parity test `packages/cli/test/session-resume.test.ts:199-236`
     with a spilled sample. Its key-equality check
     (`Object.keys(ChatMessageSchema.shape)`) fails red until both sides have
     `spill`.
8. `packages/daemon/test/persistence.test.ts`:
   - It writes `schemaVersion: 5`.
   - A v4 record reads as v5 with its messages intact.
   - A v6 record is refused and the file is untouched.
   - Restart → `snapshot` still carries the message's `spill` (the
     end-to-end resume over the daemon store).
9. `packages/tui/test/format.test.ts`: `formatChars` gives 999, 1000→"1k",
   40800→"40.8k", 16000→"16k", 1234567→"1.2M", and 999_960 does not give
   "1000k".
10. `packages/tui/test/spill-view.test.ts` (new, pure):
    - The exact note string, with and without a path.
    - `where` is absent when collapsed. Expanded, it is `saved to …` locally
      and `saved in the pod to …` in a pod.
    - A path with `\n`/bidi characters is one-lined.
    - The omitted line, and no omitted line when `omitted` is 0.
    - *Mutation:* emit `where` regardless of `expanded` → the "path only in
      ctrl+o" test fails.
11. `packages/tui/test/render-lines.test.ts` (`transcriptLines` + `stripAnsi`):
    - Collapsed: line 1 is the note, the banner text `[large ` and the path
      are absent, and `… +N more lines · ctrl+o to expand` is present.
    - Expanded: the note, `saved to <path>`, the head, `… 39.6k chars omitted …`,
      the tail, in order.
    - With `spillInPod`: `saved in the pod to`.
    - `fs_read` with a `.ts` path: the head lines contain SGR (unstripped)
      and the plain text equals `head`.
    - **Older daemon:** a tool item with banner `resultText` and no `spill`
      renders the banner verbatim.
    - *Mutation:* render `resultText` instead of the spill view → the
      collapsed test fails.
12. `packages/tui/test/resume.test.ts`: `messagesToItems` copies `spill` from
    a tool message. `state.test.ts`: `resetHistory` keeps it, and the
    `tool_result` event sets it.
13. `packages/tui/test/app.test.tsx` (ink-testing-library, the existing
    pattern): mount with `initialItems` from `messagesToItems` of a
    spilled history (the `--resume` path), and assert:
    - the frame shows the note and not the banner;
    - after ctrl+o the frame shows `saved to`;
    - with `daemonInPod`, it shows `saved in the pod to`.
14. `packages/daemon/test/integration.test.ts` (RemoteClient ↔ daemon, the
    existing harness): a spilled tool result arrives in the client
    `tool_result` with `spill`, AND a `session/snapshot` afterwards returns
    the tool message with `spill` (the live and resync paths, end to end).

### Owner decisions

- **Q1 (persisted format).** `spill` on the tool `ChatMessage`: the laptop
  store and the daemon record v4→5. An older build refuses a session that
  contains a spilled result, loudly, and never half-loads it. *Recommend A*
  (the table above). **Owner: YES, option A (2026-10-25).**
- **Q2 (no-path wording).** The owner's spec says only "says so". *Recommend*
  `40.8k chars · too large, could not be saved — the model sees only this preview`
  and no `saved to` line. **Owner: YES (2026-10-25).**
  **Owner amendment (2026-10-25) — model-facing no-path text.** When the spill
  file cannot be written, the MODEL's banner (today `output truncated to N chars
  (could not be saved to a file)`, `result-pipeline.ts:95`) becomes tool-aware,
  in this same task:
  - `fs_read`: `[large fs_read output (N chars), could not be saved to a file —
    only this preview is shown; read the file in parts with fs_read
    offset/limit]` (the original file still exists; re-reading has no side
    effects).
  - every other tool: `[large <tool> output (N chars), could not be saved to a
    file — only this preview is shown; to see more, re-run with narrower output
    (grep, head, sed -n) ONLY if the command is safe to repeat]` (the output is
    lost; never nudge the model to repeat a command with side effects).
  - The with-path banner is unchanged. Tests: one per branch (fs_read vs other),
    red first; the TUI note for this case is unchanged (Q2). Relates to the
    TODO entry on read-only pods (spill write fails).
- **Q3 (numbers).** `40.8k` (one decimal, the owner's example) vs the
  existing `formatTokens` rule (`41k`). The same choice applies to `… N chars
  omitted …`. *Recommend* the new `formatChars` (one decimal) for both. **Owner: YES, one decimal (2026-10-25).**
- **Q4 (summarised results).** Not flagged in this task (opt-in, off by
  default, no head/tail). *Recommend* leaving it as is. It is a follow-up
  only if the owner wants a note for it. **Owner: YES, leave as is (2026-10-25).**
- **Q5 (split).** Optional: `-a` live path (wire + TUI, M · cross-module,
  Sonnet-able) then `-b` persistence (ChatMessage + stores + v5, S ·
  load-bearing, Opus). *Recommend* one task, Opus executes: the two halves
  share the type and the tests, and splitting adds a release where resume
  silently shows the banner. **Owner: ONE task, Opus executes (2026-10-25).**

## Execution

*— claude-opus-5-5, 2026-10-25*

**Outcome:** implemented in the plan's order (core/protocol → agent → daemon →
client → cli → tui). Gate green: `bun run check` = typecheck clean (incl.
`apps/mobile`), lint `Checked 464 files … No fixes applied`, tests **2548 pass /
2 skip / 0 fail** (2550 across 205 files). Baseline before any edit: **2497 pass
/ 2 skip / 0 fail** (2499 across 203 files), lint clean. The 2 skips are the
same opt-in ones. Nothing committed.

### Premises re-verified (before editing)

Every `file:line` of the Implementation held on this branch (only docs changed
since 1b7d9d7), with one exception that the plan did not see, below under
*Drift 1*. Also checked by reading, and pinned by tests where cheap:
the model-facing mappers copy field by field (`openai-provider.ts:217-229`,
`anthropic-provider.ts:301-324`, `proxy-model.ts:47-61`, `hooks.ts:710`). A
grep for other field-by-field `ChatMessage` copies in `*/src` found only
`proxy-model.ts` (model-facing).

### Repro (on the unmodified tree, then after)

`.tentacle/tmp/tui-spill-note/repro.ts`, run with `bun run` from the repo root.
It is the Context repro plus case 1b (the no-path banner, per tool). Case 4 uses
a well-formed spill. Case 5 was dropped (it only served option B):

```ts
import { parseSessionRecord, spillLargeOutput } from "@tentacle/agent";
import { ChatMessageSchema, SessionUpdateSchema } from "@tentacle/protocol";
const spill = spillLargeOutput({ maxInlineChars: 16000 });
const out = await spill({ content: "x".repeat(40_800) },
  { toolName: "fs_read", toolCallId: "c1", writeSpill: async () => ".tentacle/tool-output/fs_read-c1.txt" });
console.log("1 keys:", Object.keys(out), "| first line:", out.content.split("\n")[0]);
for (const toolName of ["fs_read", "shell"]) {
  const np = await spill({ content: "x".repeat(40_800) }, { toolName, toolCallId: "c2", writeSpill: async () => null });
  console.log(`1b ${toolName} no-path:`, np.content.split("\n")[0], "| spill:",
    JSON.stringify((np as { spill?: unknown }).spill && Object.keys((np as { spill: object }).spill)));
}
const s = { chars: 40800, head: "h", tail: "t", omitted: 1 };
const upd = SessionUpdateSchema.safeParse({ type: "tool_call_update", toolCallId: "c1", status: "completed",
  content: [{ type: "text", text: "hi" }], spill: s });
console.log("2 update ok:", upd.success, "| spill kept:", upd.success && "spill" in upd.data);
const msg = ChatMessageSchema.safeParse({ role: "tool", content: "x", toolCallId: "c1", spill: s });
console.log("3 message ok:", msg.success, "| spill kept:", msg.success && "spill" in msg.data);
const rec = parseSessionRecord({ id: "u1", cwd: "/w", model: "m", title: "t", createdAt: 1, updatedAt: 1,
  messages: [{ role: "tool", content: "x", toolCallId: "c1", spill: s }] }, "u1");
console.log("4 record:", JSON.stringify(rec.ok ? "ok" : rec.reason));
```

Before (main, unmodified): the capability is missing.

```
1 keys: [ "content" ] | first line: [large fs_read output: full output (40800 chars) saved to .tentacle/tool-output/fs_read-c1.txt — read it selectively with fs_read (offset/limit) or grep; do NOT read it whole]
1b fs_read no-path: [large fs_read output: output truncated to 1200 chars (could not be saved to a file)] | spill: undefined
1b shell no-path: [large shell output: output truncated to 1200 chars (could not be saved to a file)] | spill: undefined
2 update ok: true | spill kept: false
3 message ok: true | spill kept: false
4 record: "message 0 has unknown key \"spill\""
```

After:

```
1 keys: [ "content", "spill" ] | first line: [large fs_read output: full output (40800 chars) saved to .tentacle/tool-output/fs_read-c1.txt — read it selectively with fs_read (offset/limit) or grep; do NOT read it whole]
1b fs_read no-path: [large fs_read output (40800 chars), could not be saved to a file — only this preview is shown; read the file in parts with fs_read offset/limit] | spill: ["chars","head","tail","omitted"]
1b shell no-path: [large shell output (40800 chars), could not be saved to a file — only this preview is shown; to see more, re-run with narrower output (grep, head, sed -n) ONLY if the command is safe to repeat] | spill: ["chars","head","tail","omitted"]
2 update ok: true | spill kept: true
3 message ok: true | spill kept: true
4 record: "ok"
```

"Before" lines 2–3 are the proof that an **old client ignores the field**: on
main's schemas a frame with `spill` parses and the field is stripped. So no
`PROTOCOL_VERSION` bump. It stays 11.

### As built, in order

1. **core.** `ToolResultSpill` + `ToolResult.spill` (`packages/core/src/tool.ts`).
   `ChatMessage.spill` (`packages/core/src/model.ts`), with a type-only import
   from `tool.ts`. The cycle is type-only, which is safe.
2. **protocol.** New `packages/protocol/src/spill.ts` (`ToolResultSpillSchema`,
   strip, exactly as the plan). `ToolCallUpdateSchema.spill` and
   `ChatMessageSchema.spill` are optional. Exported from the index.
   `schema/protocol.json` was regenerated (`bun run schema:export`): +32 lines,
   a `$defs/ToolResultSpill` with `additionalProperties: true` and two `$ref`s.
   `UPDATE_CLASS` is unchanged.
3. **agent.**
   - `spillLargeOutput` (`result-pipeline.ts`) returns `spill`. The banner WITH
     a path is byte-identical (pinned by an exact-string test). The no-path
     banner is the owner amendment, with two branches (`unsavedHint`: `fs_read`
     vs every other tool).
   - The two pushes (`agent.ts`, the model call and the user `/skill` round) go
     through a new `toolMessage(callId, result)` helper (*Drift 3*).
   - `session-store.ts`: `MESSAGE_KEYS` += `spill`. `isSpill` checks exactly
     `chars/head/tail/omitted` plus an optional non-empty `path` ≤ 4096. Otherwise
     → `has a malformed spill`.
4. **daemon.**
   - `eventToUpdate` spreads `spill` (`daemon/src/mapping.ts`).
   - `persisted-session.ts`: `DAEMON_RECORD_VERSION = 5`, readable
     `[1,2,3,4,5]`, and the version comment extended. A new
     `STEER_IDS_VERSION = 4` replaces the three uses of `DAEMON_RECORD_VERSION`
     that meant "v4" (*Drift 1*).
5. **client.** `updateToEvent` puts `update.spill` on `result.spill`. It is never
   derived from content (`client/src/mapping.ts`).
6. **cli.** `daemonInPod: true` is set ONLY in `runPodTui`'s `startTui`
   options (`cli/src/main.ts`). The worker, in-process and `connect` paths are
   untouched.
7. **tui.**
   - `formatChars` (`format.ts`).
   - New pure `spill-view.ts` (`spillView` → `SpillView`).
   - `ToolItem.spill` (`state.ts`), set in `applyEvent` `tool_result` and in
     `messagesToItems` (`resume.ts`).
   - `render-lines.ts`: `RenderOptions.spillInPod`, threaded as an `inPod` param
     through `toolBody`/`plainToolBody`. `spillBody`/`spillParts` (memoised in a
     `WeakMap`) handle the plain branch and the sub-agent branch.
   - `TuiOptions.daemonInPod` → `AppProps.daemonInPod` (default `false`) →
     `spillInPod` at both render-option sites in `App.tsx` (the resize warm and
     `layoutTranscript`). `daemonInPod` was added to the resize effect's deps.
8. Biome formatting was applied (`biome check --write`) to the 18 files I
   touched. They had format-only findings, nothing else.

### Tests: red → green, and mutations

Each new test was run red first. The red came from an assertion, never from an
import error: new exports were stubbed first (`formatChars` → `String(n)`,
`spillView` → empty view). Each mutation was reverted, and `shasum` was the same
before and after.

| # | Test (file) | Red on main / pre-edit | Mutation → result |
|---|---|---|---|
| 4 | `protocol/test/spill.test.ts` (new; valid kept on update + message + snapshot + open; malformed invalid; unknown inner field stripped) | 4/4 fail | ToolCallUpdate/ChatMessage `spill` removed → see #14 |
| 1 | `agent/test/result-pipeline.test.ts` (7 new) | 5 fail; "under threshold" and "summarised" pass on main (absence guards, by nature) | drop `path` from the spill → 2 fail; `53a4982…` identical |
| 2 | `agent/test/agent-spill.test.ts` (2 new: event + message, user `/skill` round) | 2 fail (message assertions, lines 122/156) | model-call push back to the inline literal → 1 fail; skill push back → 1 fail; `7a6e2c4…` identical |
| 3 | `cli/test/wiring.test.ts` "large output is the LAST transform" (redact + dedup + tabulate on, real `shell`) | fails on main at `spill` `toBeDefined` | `shaping(largeOutput)` moved before dedup → fail; `b956009…` identical |
| 7 | `agent/test/session-store.test.ts` (round-trip with/without path; 9 malformed → `message 1 has a malformed spill`) + `cli/test/session-resume.test.ts` parity (8 spill cases agree, 1 extra-inner-key "store rejects, wire strips", tripwire keys += `spill`) | 2 fail + parity red | `spill` dropped from `MESSAGE_KEYS` → 4 fail; `3e77447…` identical |
| 5 | `daemon/test/mapping.test.ts` (spill on update; no key without) | fail (pre-edit = the "drop the spread" mutation) | — (identical to red) |
| 8 | `daemon/test/persistence.test.ts` V5-1 (writes 5; v6 refused, reads 1–5), V5-2 (v4 reads as v5 with ids/rows/messages; id-less v4 turn still refused), V5-3 (restart: disk bytes pass the store's strict parser; snapshot carries `spill`) | 3 fail | `STEER_IDS_VERSION = DAEMON_RECORD_VERSION` → V5-2 + 2 existing v4 tests fail; `MESSAGE_KEYS` without `spill` → V5-3 fails (`message 2 has unknown key "spill"`); both identical after |
| 6 | `client/test/mapping.test.ts` (field → `result.spill`; banner text alone → no key) | fail (pre-edit = mutation) | — |
| 14 | `client/test/remote.test.ts` "a spilled tool result over the real stack" (RemoteClient ↔ Connection ↔ SessionHost; live `tool_result` + `session.snapshot()`) | — (written after the wire) | `spill` dropped from `ToolCallUpdateSchema` → live assertion fails; from `ChatMessageSchema` → snapshot assertion fails; `4fe4ea5…`/`811f90d…` identical |
| 9 | `tui/test/format.test.ts` `formatChars` | fail (stub) | — |
| 10 | `tui/test/spill-view.test.ts` (new, 6) | 6/6 fail (stub) | `where` regardless of `expanded` → "path only in ctrl+o" fails; `248b211…` identical |
| 11 | `tui/test/render-lines.test.ts` (7) + `read-highlight.test.ts` (2 colour tests) | 7 fail; the "older daemon: banner verbatim" guard passes on main (by nature) | spill branch removed (= render `resultText`) → 6 fail; `f7ffe3f…` identical |
| 12 | `tui/test/resume.test.ts`, `state.test.ts` (live `tool_result` + `resetHistory`) | 2 fail (pre-edit = mutation) | — |
| 13 | `tui/test/app.test.tsx` (`initialItems` from `messagesToItems` = the `--resume` path; ctrl+o; `daemonInPod`) | the pod test failed on its assertion before the prop existed; the first one fails on main (banner shown) | `spillInPod` dropped from `layoutTranscript` options → pod test fails; `0530852…` identical |
| — | `cli/test/connect.test.ts` "a `serve` daemon … never told it is in a pod" | **guard, green on main too** (pins that `connect` never sets it) | — |

Existing tests updated for the record bump (expected; each hard-coded "current
= 4" or "newer = 5"):
- `persistence.test.ts`: `base()` and two typed fixtures 4→5, U2/P-R1
  expectations 4→5, "v5 refused" → "v6 refused (reads 1, 2, 3, 4, 5)".
- `session-titles.test.ts` D6: 4→5 and newer 5→6.
- `session-list.test.ts`: a typed fixture 4→5.
- `cli/test/serve-persistence.test.ts` S1/S2 (4→5) and A11 (newer 5→6). These
  were caught by the first full gate run (3 fails), then fixed. Nothing was
  skipped.

### Drift from the Implementation (and why)

1. **`STEER_IDS_VERSION = 4` (not in the plan).** `persisted-session.ts` used
   `DAEMON_RECORD_VERSION` to mean "the v4 shape" in three places:
   - the `turnProblem` steeringIds gate;
   - `returned` read only from v4+;
   - `withoutIds` for v1–v3.

   A bare bump to 5 would silently have read a v4 record as a v1–v3 one: ids
   stripped, `returned` rows dropped, and an id-less v4 turn accepted. That
   would be a half-load. The plan's "bump the constant" premise did not hold as
   stated, so the fix is a dedicated constant. V5-2 pins it, and the mutation
   above shows that leaving it bound to the current version fails 3 tests.
2. **Protocol tests are in a new `protocol/test/spill.test.ts`**, not spread over
   `updates.test.ts`, `session.test.ts` and `forward-compat.test.ts`. The cases
   are the plan's.
3. **`toolMessage(callId, result)` helper** in `agent.ts` instead of two inline
   spreads: one rule for both pushes. The mutations target each call site.
4. **Test 14 lives in `client/test/remote.test.ts`.** `daemon/test/integration.test.ts`
   has no `RemoteClient` (raw `RpcPeer`). The RemoteClient ↔ SessionHost
   harness is in `client/test/remote.test.ts`.
5. **The colour assertions are in `read-highlight.test.ts`.** I first put them
   in `render-lines.test.ts`, and they failed there. A throwaway probe
   (`.tentacle/tmp/tui-spill-note/chalk-probe.test.ts`) showed why:
   `highlightRead` alone colours correctly (`\x1b[38;2;198;120;221mconst…`),
   but `read-highlight.ts` caches its syntax theme on first use, and earlier
   tests in `render-lines.test.ts` build it with chalk off. `theme.*` stylers
   are also fixed at import. `read-highlight.test.ts` sets `chalk.level = 3`
   for the whole module, so the property holds there. The probe stays only in
   the gitignored tmp.
6. **The 4th test of plan item 8 ("a v6 record … the file is untouched")** is a
   parse-level assertion (V5-1). "Never overwritten" is the existing
   blocked-id mechanism, already pinned by `persistence.test.ts` "a blocked id
   … is never written or removed" and `serve-persistence` A11 (byte-identical),
   which now uses v6. I did not duplicate it.
7. **`TODO.md` was not edited** (plan item 8). Its status line is updated on
   `main` after the merge, as with the previous tasks
   (`docs(todo): … done`).

### Nuances decided (all of them)

- **`omitted ≤ 0`.** This happens when the preview is ≥ the output, e.g. 150
  chars with a 200-char preview. Then `spill.head` is the WHOLE content (not
  the 100-char slice), `tail` is `""`, and `omitted` is `0`. This matches
  `content`, which today carries the whole content as its preview
  (`result-pipeline.ts`). The plan said "`head` is the whole content", and this
  makes it exact.
- **No-path banner.** The owner's strings, verbatim. `(N chars)` is the full
  output length (`content.length`), the same number as the with-path banner.
  The old `truncated to <previewChars>` figure is gone. The branch is on
  `toolName === "fs_read"` only: MCP tools and `shell_output` get the "other
  tool" text.
- **Store strictness.** `isCount` is `Number.isInteger(v) && v >= 0`, which is
  zod 3.23.8's `.int().nonnegative()` exactly (the parity test). An unknown key
  INSIDE `spill` is refused by the store and stripped by the wire, the same as
  for message keys ("stricter is safe"). Its reason is
  `has a malformed spill`, with no key name. The store accepts `spill` on any
  role (wire parity). Only `messagesToItems` reads it, and only on `tool`.
- **A v4 record holding a `spill`.** This cannot be produced by a v4 build,
  whose store refuses the key. It reads as v5 and is not refused. I did not add
  a "no spill below v5" gate. That is a deliberate leniency: a v4 file is only
  ever ours or hand-written.
- **`formatChars` rounding.** It switches to `M` once `k` rounds to 1000
  (`999_960` → `1M`, `999_940` → `999.9k`). `.0` is dropped (`16k`, `1k`,
  `12M`).
- **`spillView` cleaning.** `head` and `tail` are passed through `cleanReadText`
  (CRLF→LF, lone CR and NUL dropped) for EVERY tool, and trailing newlines are
  trimmed. Today only `fs_read` text is cleaned, so a spilled `shell` preview
  now loses its CR/NUL. That is safer in a terminal row and the same rule as a
  read. The `where` path goes through `oneLine`: a control character becomes a
  space and a bidi or zero-width character is dropped (`a\nb‮c\u0007d` →
  `a bc d`).
- **Highlighting.** `head` and `tail` are each highlighted on their own, with
  no limit (≈600 chars each), and memoised once per item for both views. A cut
  mid-token or mid-comment at a part's edge can colour that edge oddly. The text
  is still exact: the highlighter's safety net falls back to plain. An `error`
  status gets `theme.error` and is never syntax-coloured.
- **Collapse.** Unchanged (`toolLines`). A short spill body (≤ 8 lines, e.g.
  minified one-line output) shows note + head + omitted + tail even collapsed.
  The path still appears only in ctrl+o, because `where` exists only when
  expanded.
- **No row-cache key for `spillInPod`.** It is constant for an App's lifetime,
  as the plan says and as commented on the option.
- **A `modified` hook** keeps the spill view under the hook line (via
  `toolBody`). A `blocked` call is never spilled.
- **Test hygiene.** In the source, the bidi override in `spill-view.test.ts` is
  now `String.fromCharCode(0x202e)`, not a literal U+202E. Biome had left it
  literal, and a raw bidi control in source is itself a trojan-source hazard.
  Other test files in the repo already hold literal ones (e.g.
  `remote.test.ts:1922`), and I did not touch those.

### Unverified (one line each)

- `runPodTui` setting `daemonInPod: true` has no unit test (`main.ts` has no
  seam for it). The App side and the `connect` side are pinned. Verify: run
  `tentacle run`/`attach`, trigger a large `shell` output, press ctrl+o, and
  expect `saved in the pod to …`.
- The reattach replay of `tool_call_update.spill` (the replay ring stores the
  update as is) is covered by reading only. The live and snapshot paths are
  tested end to end (#14).

## Review

*— claude-opus-5-5, 2026-10-25 (fresh context; the SAME model as the executor,
so blind spots the two share can survive both passes. A different model would
make a stronger second look on a load-bearing task: AGENTS §10)*

**Verdict: APPROVE-WITH-NITS.** No finding blocks the merge. Every §7
invariant the task touches holds, as checked against the code, by mutation and
by two end-to-end scratch traces. Nit 2 needs an owner decision, but only if
the owner wants it changed. The others are notes for the doc or for later.

### Gate (re-run by the reviewer)

`bun run check`: typecheck clean (incl. `apps/mobile`), lint `Checked 464
files … No fixes applied`, tests **2548 pass / 2 skip / 0 fail** (2550 across 205
files). The two skips are the opt-in ones. These are the same numbers as
Execution.

### Findings

1. **Nit (doc only): one premise is only half true.** Design §4 says the v5 bump
   gives an older daemon the clear reason "unsupported record version 5". A
   daemon reads a file with `parseSessionRecord` (the strict store parser)
   first and runs `parseDaemonRecord` after it (`cli/src/serve.ts:214-224`).
   So for a v5 record that HOLDS a spill, a v4 daemon stops earlier, at
   `message N has unknown key "spill"`. Only a v5 record with no spill gets
   the version reason. Both paths are loud, call `persister.block(id)`, and
   print "(left as is)", so the safety property holds. Only the stated reason
   is wrong.
2. **Nit (owner decision, optional): a v4 record holding a `spill` is accepted**
   (`daemon/src/persisted-session.ts:248-266`, no gate on the version). This is
   harmless. The strict store parser has already checked the spill's shape
   (`agent/src/session-store.ts:225-238`), so it loads whole and is never
   half-loaded. A v4 build could not have written it. It does break with the
   file's own precedent: a v1/v2 record with an object title is REFUSED
   (`:242-246`), and a v1–v3 turn has its ids stripped (`:253-256`). Keep the
   leniency (my recommendation: a hand-made file only), or refuse a spill
   below v5 to match that precedent.
3. **Nit (not new): the head/tail cut is in UTF-16 units.** `spill.head` can end
   on a lone high surrogate, and it then renders as `�` (repro below,
   `😀😀�`). `content` has exactly the same cut today
   (`result-pipeline.ts:87-88`), so the field adds nothing new. The wire and
   the JSON round trip accept it (`wire parse: true`). Also, `chars` counts
   code units (`String.length`), the same as the model banner.
4. **Follow-up (as planned): `/save` still exports the banner**
   (`transcriptToMarkdown`). It is out of scope by design.

### Premise table

| Premise | Result |
|---|---|
| Context symptom: on main the spill exists only as text (repro 1, `1 keys: ["content"]`) | TRUE. Execution's "Before" output shows it on the unmodified tree, and the no-spill guard test still renders the banner as it is. |
| `spillLargeOutput` at `result-pipeline.ts:77-99`: head/tail = `slice`s, `omitted` | TRUE (`:85-90`) |
| Order: redact → hooks → … → large output last; skill exempt (`wiring.ts:184-196`) | TRUE (`:184-196`), pinned by the new wiring test |
| Model-facing mappers copy field by field (OpenAI `:217-229`, `proxy-model.ts:47-58`, `hooks.ts:710`) | TRUE (all read). No `...m` spread exists in `providers`/`agent`/`daemon` src. |
| `tool_call_update` is `display`; `PROTOCOL_VERSION = 11` | TRUE (`updates.ts:227`, `version.ts:7`, `version.ts` has no diff against main) |
| `runPodTui` is the only TUI entry for `run` AND `attach` | TRUE (`main.ts:550`, `main.ts:597`). `daemonInPod` is set only at `main.ts:488`. The worker (`:634`), in-process (`:689`) and `connect` (`connect.ts:123`) leave it unset. `...sessionOptions` (`TuiSessionOptions`) cannot override it. |
| Compaction drops the spill with its message (`compact.ts:228-248`) | TRUE. Only system + summary + rebuilt `skill` rounds are kept, and a `skill` result is never spilled. |
| Replay ring stores the update as is | TRUE. `ring.push(params)` (`hosted-session.ts:893`), and `frameFor` only drops `mandatory` (`daemon/mapping.ts:244-258`). Shown by the repro below. |
| Plan premise "every `DAEMON_RECORD_VERSION` use = current" | FALSE. Execution caught it (Drift 1). I re-grepped every use: only the write (`:113`), the readable list (`:32`), the normalised `schemaVersion` (`:261`) and the type (`:84`) remain. Titles (`CHOSEN_TITLE_VERSION = 3`), archive (`=== 1`) and steer ids/`returned` (`STEER_IDS_VERSION = 4`) are all pinned to constants. No other package uses the constant. |

### Mutations (all reverted; `shasum` of the 5 files is identical before and after; `git status --short` is still 43 entries)

| Mutation | Result |
|---|---|
| M1 `spill-view.ts`: `where` regardless of `expanded` | 3 fail (spill-view "path only in ctrl+o", render-lines collapsed, app `--resume`) |
| M2 `resume.ts`: drop the `spill` spread | 4 fail (resume, state resync, both app tests) |
| M3 `persisted-session.ts`: `STEER_IDS_VERSION = 5` (the Drift-1 trap) | 3 fail (P-R1, Q-R2, V5-2) |
| M4 `client/mapping.ts`: drop the `spill` spread | 2 fail (mapping, remote real-stack) |
| M5 `result-pipeline.ts`: `do NOT` → `do not` in the with-path banner | 1 fail (the exact-string test): the model's text is byte-pinned |

### Attacks tried

1. **Reattach replay, the gap Execution left unverified.** I ran a scratch trace
   (`.tentacle/tmp/tui-spill-note-review/replay.ts`) through the real
   `HostedSession` → `attach(…, cut)` → client `updateToEvent` → TUI
   `applyEvent` → `transcriptLines`. Output: `resync: false | replayed: 5`,
   `replayed update spill keys: [chars, head, tail, omitted]`. The row shows
   `6k chars · too large, could not be saved — the model sees only this
   preview`, then `… 4.8k chars omitted …` in ctrl+o, and no banner.
   **Holds.**
2. **Did the model's content change?** The CR/NUL cleaning is in `spill-view.ts`
   `shown()` only, on the TUI side. `spill.head`/`tail` and `content` are the
   raw slices (`result-pipeline.ts:87-97`). The with-path banner is pinned
   byte for byte (M5). Only the no-path banner changed, and it matches the
   owner's two strings verbatim (Execution repro 1b). **Holds.**
3. **Edge cases** (`edges.ts`). At the exact threshold (100 chars,
   `maxInlineChars` 100) nothing is spilled. With preview 0 the row is note +
   `saved to` + `… 50 chars omitted …` and no empty head line. Wide CJK and
   emoji render. A surrogate cut gives `�` (nit 3). **Holds.**
4. **Every older-build path is loud and leaves the file alone.** An older
   laptop build reports `unknown key "spill"`. An older daemon blocks the
   record and leaves the file as is through both rejection routes
   (`serve.ts:214-224`, nit 1). An older client strips the field and shows
   today's banner. **Holds.**
5. **Pod trust.** Pod-supplied spill text goes through the wire schema
   (`path` 1..4096), and the path through `oneLine`. It is display-only and
   grants nothing on the laptop. The laptop store re-validates it strictly.
   Pod daemons still persist nothing (no persister was added). **Holds.**
6. **Q4 / sub-agent / MCP / shell_output.** `summarizeLargeOutput` is untouched
   and exclusive with spill (`wiring.ts:188-193`). The other cases all go
   through `transformResult` (read). **Holds.**

### What holds

The owner principle holds: no code parses the banner or the `…[N characters
omitted]…` marker. A grep of the TUI and client diffs finds only spreads of the
field. The strings are the owner's, verbatim (`TODO.md:840-848`, Q2, Q3).
The logic is in the pure `spill-view.ts`, and `render-lines.ts` only assigns
colour and order. Collapse (`toolLines`) is unchanged, and `fs_read`
highlighting uses the existing `highlightRead`.

### How the executor behaved

The executor was rigorous and honest. It caught a real half-load trap that the
plan missed (Drift 1) and pinned it with a mutation. It listed its own
leniencies (nit 2) and its unverified items instead of hiding them. Each red
test failed on an assertion, never on an import error. Its gate numbers match
the reviewer's exactly. One slip: the plan's clear-reason claim (nit 1) was
carried into Execution without re-checking the order of the two parsers.
