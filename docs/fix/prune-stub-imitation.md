# fix/prune-stub-imitation — weak models copy prune stubs from their own past edits

> **Status:** implementation (APPROVED — orchestrator decisions under owner delegation)
> **Branch:** `fix/prune-stub-imitation`
> **Size:** M · **Blast:** cross-module (agent context projection, what every model is sent) · **Suited:** Opus plan → DeepSeek exec, Opus review
> **Changelog:** `changelog.d/prune-stub-imitation.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-26*

Smart compaction's R2 (`call_payload`) replaces the payload strings of an old,
successful `fs_write`/`fs_edit`/`fs_multi_edit` INSIDE the call's arguments with
`⟪pruned by tentacle: N chars, already written to P — fs_read P if you need the text⟫`
(`packages/agent/src/prune.ts:220-224`, applied by `pruneArguments` `:397-438`).
To a weak model that string sits exactly where a value goes in a call it made
itself, so it reads as a value to imitate.

**Evidence (owner's `~/assistant` serve, Qwen3.8 27B, session
`c551bc09-0a9e-4fc3-9fa2-633bdf7bc779`).** `news/SCHEMA.md` was written at
assistant round 30 (`fs_write`, 3 058 chars of args) and edited at round 35
(`fs_edit`, 1 037). Both fell out of the 6-round protected tail and were
R2-stubbed. At round 43 the model emitted an `fs_multi_edit` on `news/SCHEMA.md`
whose 4 `old_string`/`new_string` pairs were ALL invented stubs
(338→481, 249→240, 214→241, 492→492 chars):

```
{"edits":[{"old_string": "⟪pruned by tentacle: 338 chars, already written to news/SCHEMA.md — fs_read news/SCHEMA.md if you need the text⟫", "new_string": "⟪pruned by tentacle: 481 chars, already written to news/SCHEMA.md — …⟫"}, …],"path":"news/SCHEMA.md"}
→ refused: the text to write contains a pruned placeholder ("⟪pruned by tentacle: …⟫"), which is not file content — fs_read news/SCHEMA.md first and write the real text (nothing was written)
```

The write guard (`packages/tools/src/builtins.ts:389-400`) refused; the model
re-read the file and re-sent the IDENTICAL call (round 45, refused again), then
fell back to a whole-file `fs_write` (round 46). No file was corrupted, but two
wasted rounds and a full rewrite. The same imitation was seen with DeepSeek in
the eval/prune-real-usage safety run (TODO.md, 23/11: two refused
`fs_multi_edit`s). Owner decision (TODO, 26/11 «ok 2 e 3 insieme»): fix BOTH
(2) keep recent write/edit payloads on a path still being worked on, and
(3) move the "text omitted" note out of the call's string arguments; keep the
write guard as is.

**Repro** (2026-11-26, `.tentacle/tmp/prune-stub-imitation/repro.ts`, run from
the worktree root with `bun ../../tmp/prune-stub-imitation/repro.ts`):

```ts
import type { ChatMessage, ToolCall } from "@tentacle/core";
import { applyPrune, pruneCandidates } from "../../worktrees/prune-stub-imitation/packages/agent/src/prune.ts";

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id, name, arguments: JSON.stringify(args),
});
const round = (c: ToolCall, result: string): ChatMessage[] => [
  { role: "assistant", content: "", toolCalls: [c] },
  { role: "tool", content: result, toolCallId: c.id },
];
const filler = (n: number, from: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => round(call(`f${from + i}`, "shell", { command: "ls" }), "exit=0\nok")).flat();

const P = "news/SCHEMA.md";
const history: ChatMessage[] = [
  { role: "user", content: "go" },
  ...round(call("w30", "fs_write", { path: P, content: "s".repeat(3000) }), `wrote 3000 bytes to ${P} (+90 -0)`),
  ...filler(4, 31),
  ...round(call("e35", "fs_edit", { path: P, old_string: "o".repeat(338), new_string: "n".repeat(481) }), `edited ${P} (+6 -4)`),
  ...filler(7, 36), // rounds 36-42: round 35 falls out of the 6-round protected tail
];
const out = applyPrune(history, pruneCandidates(history));
for (const [i, m] of out.entries()) {
  if (m.role === "assistant" && m.toolCalls?.[0]?.name.startsWith("fs_")) {
    console.log(`[${i}] ${m.toolCalls[0].name} args: ${m.toolCalls[0].arguments}`);
    console.log(`[${i + 1}] result: ${out[i + 1]?.content}`);
  }
}
```

Output on `main` (57d23bf4):

```
[1] fs_write args: {"path":"news/SCHEMA.md","content":"⟪pruned by tentacle: 3.0k chars, already written to news/SCHEMA.md — fs_read news/SCHEMA.md if you need the text⟫"}
[2] result: wrote 3000 bytes to news/SCHEMA.md (+90 -0)
[11] fs_edit args: {"path":"news/SCHEMA.md","old_string":"⟪pruned by tentacle: 338 chars, already written to news/SCHEMA.md — fs_read news/SCHEMA.md if you need the text⟫","new_string":"⟪pruned by tentacle: 481 chars, already written to news/SCHEMA.md — fs_read news/SCHEMA.md if you need the text⟫"}
[12] result: edited news/SCHEMA.md (+6 -4)
```

Both bugs are visible: the path was edited 8 rounds before "now" and both its
payloads are gone (2), and the stub sits in the argument values (3).

## Implementation

*— claude-opus-5-5, 2026-11-26*

**APPROVED** (orchestrator, under the owner's delegation; no choice below
touches an AGENTS §7 trust rule — the write guard is unchanged and stays the
backstop).

#### Orchestrator decisions

- **D1 — fix (3) shape: DROP the payload keys from the arguments; the note goes
  on the tool RESULT.** An R2-pruned call keeps `path` and every non-payload
  field (`replace_all` of `fs_edit`); `fs_write` loses `content`, `fs_edit`
  loses `old_string`/`new_string`, `fs_multi_edit` loses `edits` (the whole
  array). Its result message keeps the tool's own success line and gets ONE
  appended line carrying the marker. *Why:* a missing key cannot be copied as a
  value, and a call imitating the stripped shape fails the tool's schema
  (`content`/`old_string`/`new_string`/`edits` are required —
  `builtins.ts:402-405`, `:435-446`, `:509-523`; validated before `execute`,
  `packages/tools/src/registry.ts:96-102`), so it writes nothing. Rejected:
  (a) empty-string payloads — an imitated `fs_write {content:""}` would
  TRUNCATE the file and the guard cannot see it; (b) a shorter/reworded stub in
  the arguments — still a string where a value goes, still copyable.
- **D2 — fix (2) rule: on an ACTIVE path, the last 2 successful write/edit
  calls keep their payload.** A path is active when any call naming it
  (`fs_read`/`fs_write`/`fs_edit`/`fs_multi_edit`) sits in the last
  `2 × keepRecentRounds` assistant rounds (12 by default). *Why:* a batch is
  final (`agent.ts:1245-1255` never removes an entry), so "still working on"
  must be decided at batch time from what is recent; 2× the tail covers the
  evidence (last SCHEMA.md edit at round 35, batch at rounds 41–43 → window
  starts at 29–31 → active) while a file not touched for 12 rounds is released;
  K = 2 is the owner's example and what the model mirrored (its latest write +
  edit of that file). Cost is bounded by activity (≤ 2 payloads per recently
  touched path), unlike "last 2 per path forever", which would keep nearly
  every R2 payload of the evidence session (17 news files each written once and
  edited once). Derived from `keepRecentRounds`, so **no new config key**.
- **D3 — the result note keeps `PRUNE_MARKER`.** Every stub carries it (the
  guard's trigger, `prune.ts:41-47`); a model that copies the note into a write
  is still refused.

### Load-bearing assumption

A call whose payload keys are ABSENT is (a) a valid history for every provider
and (b) non-imitable into a write. (a) `pruneArguments` already emits
`JSON.stringify` of a parsed object (`prune.ts:437`); the Anthropic provider
sends `parseArgs(call)` as the `tool_use` `input` (`anthropic-provider.ts:628`)
and the OpenAI-compatible one sends the arguments string — neither validates a
past call against the tool schema. (b) is proven by the schemas + registry cited
in D1. *Unverified:* that the live Anthropic API accepts a historical `tool_use`
whose input misses a required key (no strict tools are used); verify with one
Haiku request replaying a stripped call (owner's API credits) before relying on
it for Anthropic profiles.

### Preconditions

- R2 is decided per assistant message in the candidates loop
  (`prune.ts:526-559`), only for calls whose result matches the tool's success
  shape (`:347-367`); the stored history is never mutated (`:696-712`).
- The protected tail is the last `keepRecentRounds` assistant messages
  (`prune.ts:473-486`); `maybePrune` passes the configured value
  (`agent.ts:1231`).
- Every `CallSite` already carries its `path` (range suffix stripped) and its
  result (`prune.ts:491-519`) — enough to compute "active path" and "last 2 on
  P" without new scanning.
- An entry pins its `original` by identity and is skipped when the index holds
  another message (`prune.ts:696-712`, `agent.ts:1234`, `:1248`).
- The write guard (`builtins.ts:389-400`, called at `:414`, `:492`, `:533-536`)
  is unchanged; its tests (`packages/tools/test/prune-guard.test.ts`) stay as is.
- Prefix-cache stability: every stub is a pure function of the stored history
  (`prune.ts:28-31`, `:150-155`); both new rules keep that.

### Design

All in `packages/agent/src/prune.ts`:

1. **Active paths + protected payload calls** (fix 2). After the `sites` scan,
   compute `activeFrom = assistantIndices.at(-2 × keepRecentRounds) ?? 0`;
   `active = {site.path | site.index ≥ activeFrom}` over `fs_read` and the
   `PAYLOAD_TOOLS`. Then, per active path, the call ids of the LAST 2
   successful `PAYLOAD_TOOLS` sites (by history order; several calls in one
   message count separately) form `keepPayload: Set<string>`. In the R2 branch,
   a call in `keepPayload` is pushed unchanged (like a failed one).
2. **Strip, don't stub** (fix 3). `pruneArguments` deletes the payload keys
   instead of replacing them: `content`; `old_string`, `new_string`; `edits`.
   It returns `{arguments, removedChars, edits?}` (`edits` = the array length
   for `fs_multi_edit`). Non-JSON arguments → `undefined` (unchanged).
3. **The note on the result.** New pure `payloadNote({chars, path, edits})`
   replaces `payloadPlaceholder` (no other caller: `rg payloadPlaceholder`
   finds only `prune.ts`), e.g.
   `⟪pruned by tentacle: the text this call sent (4 edits, 1.6k chars) is not shown any more — it is in news/SCHEMA.md; fs_read news/SCHEMA.md if you need it⟫`
   (path missing → "the file"). `stubFor({rule:"call_payload"})` returns it, so
   the "every stub carries the marker" contract holds. The R2 branch adds a
   SECOND entry at the result's index: `{rule:"call_payload", original: result,
   message: {...result, content: `${result.content}\n${note}`}, savedChars: 0}`.
   The assistant entry carries the NET saving `Σ removedChars − Σ note.length`;
   if that is ≤ 0 for the message, neither entry is made (pruning must save
   something). Document the `savedChars: 0` result entry on `PruneEntry.savedChars`
   next to the `viewed_image` exception (`prune.ts:72-76`).
4. **R2 owns its result index.** A result whose call was R2-pruned is skipped by
   `ruleFor` (in practice R5 never fires on a ~40-char success line, but the
   rule must be explicit, not an accident of `savedChars`).
5. Update the module header's R2 line (`prune.ts:13-14`) and the `call_payload`
   comment (`:207-208`) to the new shape.

### Files

1. `packages/agent/src/prune.ts` — the design above.
2. `packages/agent/test/prune.test.ts` — rewrite the R2 block (`:237-322`) to the
   new contract + the new cases below.
3. `packages/config/src/key-docs.ts:904` — the `contextPrune.enabled` text:
   "write/edit payloads already on disk (except the last two on a file still
   being worked on)"; the stub wording stays generic.
4. `docs/feat/smart-compaction.md` — one dated amendment line under the R2 row
   (`:201`, `:214`) pointing here.
5. `changelog.d/prune-stub-imitation.fixed.md` — one bullet: with smart
   compaction on, a model no longer sees `⟪pruned by tentacle…⟫` placeholders
   inside its own earlier write/edit calls (the note moves to the call's result)
   and the latest edits of a file it is working on are kept.

No protocol, persistence, or tools change.

### Failure modes

- **Model imitates the stripped shape** (`fs_edit {"path":P}`) → schema error
  `invalid arguments for fs_edit: …` (`registry.ts:96-102`), nothing written;
  the model retries with real text. Strictly safer than today.
- **Model copies the result note into a write** → the unchanged guard refuses.
- **A path goes idle and is pruned, then the model returns to it** → the
  entry is final (`agent.ts:1245-1255`); the model sees `{"path":P}` + the
  note on the result, no copyable string. D2 reduces frequency; D1 removes the
  hazard.
- **Half-applied pair** (history replaced in place so only one of the two
  indices still holds its `original`) → `applyPrune` applies the live one only:
  either stripped args with no note (no copyable string) or a note beside the
  full args (harmless). Converges at the next batch / history replacement.
- **Tiny payloads** (net saving ≤ 0) → no R2 for that message, both entries
  absent.
- **Failed / non-success-shaped result, non-JSON args, missing result** → no R2
  (unchanged: `prune.ts:537-546`).
- **Multiple calls in one message, some protected** → protected calls pushed
  unchanged; only stripped calls contribute removed chars and a result note.
- **Empty history / no assistant rounds** → `activeFrom` 0, nothing to prune
  (existing empty-history case holds).
- **Cache stability** → both rules are functions of the stored history only;
  the determinism case is extended to histories with writes.

### Tests

All in `packages/agent/test/prune.test.ts`, existing `round`/`call`/`filler`
helpers. Each marked **(red)** must be shown failing on `main` on its assertion.

- **T1 regression, the real shape (red).** `fs_write` P (3 000 chars) then
  `fs_multi_edit` P with the evidence's 4 pairs (338/481, 249/240, 214/241,
  492/492), both followed by ≥ 13 filler rounds (path INACTIVE, so only fix 3
  is exercised): after `applyPrune`, NO string anywhere in any call's parsed
  arguments contains `PRUNE_MARKER`.
- **T2 stripped arguments (red).** `fs_write` has no `content`; `fs_edit` has
  no `old_string`/`new_string` and keeps `replace_all`; `fs_multi_edit` has no
  `edits`; `path`, `id`, `name` kept; arguments parse as a JSON object.
- **T3 non-imitable (red).** Each stripped argument object fails
  `fsWriteTool`/`fsEditTool`/`fsMultiEditTool` `.inputSchema.safeParse`
  (imported from `@tentacle/tools`) — today's stubbed args PASS it.
- **T4 the note on the result (red).** The result entry's content is the
  original success line, `\n`, then a note containing `PRUNE_MARKER`, the path,
  the size; for `fs_multi_edit` "4 edits". The stored result is unchanged.
- **T5 active path keeps the last 2 (red).** Write + edit + edit on P, then
  7 filler rounds (all three outside the 6-round tail, P inside the 12-round
  window): the two LATER calls' arguments are byte-identical to the stored
  ones, the first is stripped. Plus: a second path Q last touched 13+ rounds
  ago is stripped in the same history. Plus: an `fs_read` of P in the window
  alone makes P active.
- **T6 net gain.** A small edit (payload shorter than its note) → no entry at
  either index; `estimateGain` equals `Σ payload − Σ note` for a real one.
- **T7 failed write** (existing `:311-321`) → payload kept AND no result note.
- **T8 validity + determinism.** `modelView(out).repairs` is `null` and two
  computations are byte-identical on a history with R2 entries.
- **Mutation (§9):** (a) restore the in-argument placeholder → T1/T2/T3 fail;
  (b) make `keepPayload` empty → T5 fails; revert both.

Gate: `bun test packages/agent/test/prune.test.ts packages/agent/test/prune-loop.test.ts packages/tools/test/prune-guard.test.ts`
while iterating; `bun run check` before done. Re-run the repro: the fs_write and
fs_edit at rounds 30/35 must keep their payloads (P active), and with 13+ filler
rounds must show `{"path":"news/SCHEMA.md"}` + a noted result.

## Execution

*— claude (Claude Code CLI 2.1.332; the harness exposes no exact model id), 2026-11-26*

**Load-bearing check — PASSES.** `.tentacle/tmp/prune-stub-imitation/loadbearing.ts`
(built from `fsWriteTool/fsEditTool/fsMultiEditTool.inputSchema`, `.safeParse`):

```
today fs_write stub (stub in a value):        safeParse.success = true
today fs_edit stub (stub in a value):         safeParse.success = true
today fs_multi_edit stub (stub in a value):   safeParse.success = true
stripped fs_write (no content):               safeParse.success = false
stripped fs_edit (no old/new_string):         safeParse.success = false
stripped fs_multi_edit (no edits):            safeParse.success = false
```

So (b) holds exactly: today's shape is imitable and runs (the guard then
refuses), the stripped shape cannot run at all. (a) re-verified statically:
`parseArgs` is a bare `JSON.parse` (`anthropic-provider.ts:628`, `:671`) and a
past call is never validated against the tool schema (only
`registry.ts:96-102`, at execution). The doc's own unverified item stands: no
live Anthropic request was made (no API credits here).

**Repro before** (`repro.ts`, on `57d23bf4`) — the doc's output, byte for byte:
`[1] fs_write args: {…,"content":"⟪pruned by tentacle: 3.0k chars, already written to
news/SCHEMA.md …⟫"}`, `[11] fs_edit args: {… old_string/new_string
placeholders …}`.

**Repro after.** `repro.ts` (same history, 7 filler rounds): both the round-30
`fs_write` and the round-35 `fs_edit` keep their payloads untouched — P is
ACTIVE (10 assistant rounds < 2 × 6), so nothing is pruned and no note appears.
`repro2.ts` (15 filler rounds, P idle):

```
[1]  fs_write args: {"path":"news/SCHEMA.md"}
[2]  result: wrote 3000 bytes to news/SCHEMA.md (+90 -0)
     ⟪pruned by tentacle: the text this call sent (3.0k chars) is not shown any more — it is in news/SCHEMA.md; fs_read news/SCHEMA.md if you need it⟫
[11] fs_edit args: {"path":"news/SCHEMA.md"}
[12] result: edited news/SCHEMA.md (+6 -4)
     ⟪pruned by tentacle: the text this call sent (819 chars) is not shown any more — …
```

Both halves of the plan's acceptance line are met.

**As built, in order**

1. `packages/agent/src/prune.ts`
   - module header R2 line, the `call_payload` comment and
     `PruneEntry.savedChars`'s doc rewritten to the new shape (incl. R2's
     `savedChars: 0` result entry, beside the `viewed_image` exception).
   - `payloadPlaceholder` → `payloadNote({chars, path, edits})` (the only
     caller was `prune.ts`, so no other file changed): "the text this call sent
     (4 edits, 1.6k chars) is not shown any more — it is in P; fs_read P if you
     need it⟫"; `stubFor({rule:"call_payload"})` returns it, so the "every stub
     carries the marker" contract holds.
   - `pruneArguments` now DELETES `content` / `old_string`+`new_string` /
     `edits` (computed `delete`, per the Biome `noDelete` rule) and returns
     `{arguments, removedChars, edits?}`; no placeholder is ever put back.
   - `CallSite.resultIndex` added (filled where the result is matched to its
     call), so R2 can name the result it annotates.
   - D2, before the candidates loop: `activeFrom = assistantIndices.at(-2 ×
     keepRecentRounds) ?? 0`; `active` = paths of `fs_read`/`PAYLOAD_TOOLS`
     sites at/after it; `keepPayload` = the last `KEEP_ACTIVE_PAYLOADS` (2)
     successful payload calls per active path, collected by walking `sites`
     **in reverse** (so it is the LAST two, not the first).
   - the R2 branch: a call in `keepPayload` is pushed unchanged; a stripped call
     contributes `removedChars` and one note; the assistant entry's `savedChars`
     is the NET (`Σ removedChars − Σ note.length`) and both entries are skipped
     when that is ≤ 0; each note becomes a second entry at its result's index
     (`{...result, content: `${result.content}\n${note}`}`, `savedChars: 0`).
   - design item 4 made explicit: a `claimed` set of the result indices R2 owns
     short-circuits the tool-message branch, so `ruleFor` (in practice R5) never
     overwrites the note.
2. `packages/agent/test/prune.test.ts` — the R2 block rewritten to the new
   contract: T1 (the evidence's own shape, 4 edits + 13 filler rounds, no marker
   in any call's arguments, `{"path":…}` + noted result), T2 (per tool: the keys
   are gone, `path`/`id`/`name`/`replace_all` stay, still a JSON object), T3
   (each stripped object fails the tool's `inputSchema.safeParse`, and the
   stubbed object still PASSES — the check is not vacuous), T4 (result = success
   line + `\n` + note; "4 edits" for a multi-edit; the stored result unchanged),
   T5 (write+edit+edit on P then 7 rounds → the two later calls byte-identical,
   the first stripped; an idle path stripped beside an active one in the same
   history; a lone `fs_read` in the window keeps a path active), T6 (a payload
   smaller than its note → no entry at either index; `estimateGain` = payload −
   note), T7 (failed write: unchanged history, no note), T8 (`repairs` null,
   byte-identical across two runs). Plus one case the Tests list did not name
   but the Failure modes did: **one message with two calls**, the idle path's
   call stripped and noted, the active path's call byte-identical and un-noted.
3. `packages/config/src/key-docs.ts:904` — `contextPrune.enabled` details:
   "write/edit payloads already on disk (except the last two on a file still
   being worked on)".
4. `docs/feat/smart-compaction.md` — the dated amendment under the R2 row.
5. `changelog.d/prune-stub-imitation.fixed.md` — one bullet.

**Drift from the Implementation (all deliberate, each a site the plan
under-specified)**

- The plan said "one dated amendment line under the R2 row". Three more places
  in the same file had to move with the code, otherwise the doc would describe
  a shape that no longer exists: the R2 row's "Stub keeps" cell, the paragraph
  quoting the in-argument placeholder (now the result note), and `:481`'s
  "`payloadPlaceholder` and `formatChars` are exported" → `payloadNote`. Same
  file, same section, no new scope.
- `pruneArguments` lost its `path` parameter: the placeholder it existed for is
  gone, and the note (which needs the path) is built by the R2 branch from the
  `CallSite`. Matches the plan's stated return shape.
- `fs_multi_edit` with a single edit renders no "(1 edits, …)" prefix
  (`edits < 2` → omitted); the plan's example only fixes the "4 edits" case.
- A note is also appended when the pruned call is the last candidate and its
  result is the first message of the protected tail. The alternative (stripped
  arguments with no note anywhere) is the incoherent state the design forbids,
  so the note wins; the module's tail comment ("the last `keepRecentRounds`
  assistant rounds are never candidates") remains true.
- `packages/agent/test/prune.test.ts` gained a `rawArgs` helper: comparing
  `arguments` inline tripped `toBe(expected: string)` under Bun's types.

**Known, NOT changed (out of this task's scope).** `docs/feat/smart-compaction.md:1559`
and `:1587` state that R2 "rewrites `toolCalls` and leaves `content` alone", so
a pruned assistant message still counts as a cached prefix in the cost model.
With the note on the result that is now only half true (the prefix also breaks
at the annotated result). That paragraph is a cost-model analysis, not a
behaviour claim; it needs its own eval, not a silent edit inside this fix.

**Mutation (§9) — non-vacuity, both reverted**

- (a) the in-argument placeholder restored (`out[key] = "⟪pruned by tentacle: …⟫"` for a
  string payload) → `47 pass / 6 fail`: T2 `fs_write`, T2 `fs_edit`, T1, T3,
  plus the two T5 cases that also assert the drop.
- (b) `KEEP_ACTIVE_PAYLOADS = 0` → `50 pass / 3 fail`: exactly the three T5
  cases (active path keeps last two; idle vs active; `fs_read` keeps active).

**Gate (narrow, per §4; the orchestrator's script runs the whole one)**

- `bun test packages/agent/test/prune.test.ts packages/agent/test/prune-loop.test.ts
  packages/tools/test/prune-guard.test.ts packages/config/test/key-docs.test.ts`
  → **106 pass, 0 fail**.
- `bunx tsc --noEmit -p packages/agent` → no error in `prune.ts`/`prune.test.ts`
  (two pre-existing, unrelated errors remain in `harness/a2a-map.ts` and
  `harness-a2a-registry.test.ts`; this branch does not touch them).
- `bunx biome check` on the three changed code files → clean.
- No schema/protocol change → `packages/protocol/schema/protocol.json` needs no
  regeneration; no `protocol.d/` note.

## Review

*— claude-opus-5-5, 2026-11-26*

**Verdict: APPROVE-WITH-NITS** (no HIGH/MEDIUM). Fresh context; same model as
the Implementation's author (not the executor, DeepSeek) — shared planning
blind spots may survive.

**Gate:** `bun run check` → typecheck clean, `biome` clean (2715 files),
**20815 pass · 5 skip · 0 fail** (skips are environment/opt-in, none in a
touched file). Touched files: 69 pass.

**Premises (TRUE):** `registry.ts:96-102` validates the schema before
`execute`; `anthropic-provider.ts` sends `parseArgs(call)` as `input`;
`maybePrune` keeps live prior entries and adds only fresh indices
(`agent.ts:1228-1252`); candidates ascend, so `claimed` is set before the
result index is visited; `keepRecentRounds` min 1 (`config/schema.ts:535`).

**Mutations** (restored byte-identical, `git status` clean): (a) payload
key → marker string: 8 fail; (b) `keepPayload` never filled: 4 fail;
(c) `activeFrom = 0`: 10 fail; (d) net-gain gate removed: 1 fail;
(e) `claimed` skip disabled: **0 fail** (nit 1).

**E2E trace** (`.tentacle/tmp/prune-stub-imitation/trace.ts`, evidence shape,
13 idle rounds): args become `{"path":"news/SCHEMA.md"}`, results gain the
note ("4 edits, 2.7k chars"), 0 markers in any argument, both stripped args
FAIL `fsWriteTool`/`fsMultiEditTool` schemas.

**Attacks tried:** cross-batch half-pair (prior R5 entry on the result, R2
fresh on the call → stripped args, no note: no copyable string — safe);
result index in the protected tail (impossible: a result precedes the next
assistant); net-gain under-count when the note is not applied (under-estimate
only); duplicate tool-call ids (pre-existing `callById` assumption; ids are
provider- or UUID-generated).

**Nits (LOW):**
1. `prune.ts` `claimed` guard is untested (mutation e survives). Reachable
   when R5 fires on a write result (same args, byte-identical later result);
   the outcome is still safe (no note, no copyable string). Add a test.
2. Unverified, as the plan says: the live Anthropic API accepting a historical
   `tool_use` missing required keys — one Haiku replay settles it.

**Executor:** followed the plan; tests match T1–T8 and are non-vacuous.
