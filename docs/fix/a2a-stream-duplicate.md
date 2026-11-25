# fix/a2a-stream-duplicate — An A2A answer reaches the parent's report twice

> **Status:** implementation (approved) · execution not started
> **Branch:** `fix/a2a-stream-duplicate`
> **Size:** S · **Blast:** cross-module · **Suited:** DeepSeek (executes; standard in-context Review — no §7 wire/persistence invariant changes, but the harness event type is shared by every adapter, so Review re-runs `packages/agent` + `packages/daemon` a2a tests)
> **Changelog:** `changelog.d/a2a-stream-duplicate.fixed.md` — one bullet: `- **A2A sub-agent answers are no longer duplicated.** A server that closes an artifact by re-sending its whole text (\`append:false\`, \`lastChunk:true\`) no longer makes the parent see the answer twice; the client now honours A2A \`append:false\` as a REPLACE of that artifact's text.`

<!--
Footprint note (Size): 4 source files, ~70 added lines, plus 3 test files — an S
in lines, at the S/M boundary in files. Blast is cross-module because
`HarnessEvent` ("output") is the seam every adapter shares and `child.ts` is the
ONE report assembler for all of them; the change is additive (an optional field
+ a pure buffer) and no wire, persisted format or §7 invariant moves.
-->

## Context

*— claude-sonnet-5-5, 2026-11-26*

Two tentacle agents over A2A: **A** = `serve` + `harnesses.bravo` (`a2a`, driven by
MCP), **B** = `serve --a2a-token-command`. A asks B «Rispondi solo con la parola:
CIAO». A's model receives B's answer **twice** — the owner's e2e reported
«Il codice segreto … OTTARINA-42Il codice segreto … OTTARINA-42» (TODO.md:18).
Direct `SendStreamingMessage` to B shows the wire shape behind it:

```
artifactUpdate {artifactId: "response", parts:[text "CIAO"], append absent/false, lastChunk:false}
artifactUpdate {artifactId: "response", parts:[text "CIAO"], append absent/false, lastChunk:true}
statusUpdate   {state: COMPLETED}
```

Per A2A 1.0, `append:false` means **REPLACE** the artifact's content so far, so
this stream is legal and its composed artifact is `"CIAO"` — once. The client
computes that: `packages/agent/src/harness/a2a-map.ts:306-311` keeps the text in
`state.artifacts` and marks the event `replace: true` (`a2a-map.ts:197`,
`types.ts:98-99`). But **nothing consumes `replace`** (only `types.ts` and
`a2a-map.ts` mention it): the report the parent reads is assembled by appending
every `output` text — `packages/agent/src/harness/child.ts:449`
(`if (ev.text) report += ev.text`) — and returned as `SubagentResult.report`
(`child.ts:528-539`, `packages/agent/src/subagent.ts:150`). So a legal server
makes the parent see the answer twice.

Which end is wrong: the **client**. B's trailing whole-text artifact is legal,
wasteful, and useful (it is the one in-stream reconciliation for a client that
joined mid-stream); fixing the server would hide our non-compliance only for our
own pairing, while any other compliant server would still duplicate
(AGENTS §7: the client must hold against a compliant peer, not against us).

**Repro** (on `main`, before any edit; `.tentacle/tmp/a2a-stream-duplicate/`,
AGENTS §6 — the file is gitignored, so it is pasted here in full):

```sh
cd /Users/gmeghnag/tentacle/.tentacle/tmp/a2a-stream-duplicate
bun test ./proof.test.ts
```

`proof.test.ts` feeds **the exact wire sequence above** to the real client mapper
(`mapStreamResponse`) and pushes the resulting events into the real runner
(`createSubagentRunner` + a fake remote adapter, the seam of
`packages/agent/test/harness-remote-fit.test.ts:46-172`), then counts the answer
in `result.report`. Observed 2026-11-26:

```
proof.test.ts:
mapped events: [{"kind":"output","text":"CIAO"},{"kind":"output","text":"CIAO","replace":true},{"kind":"end","status":"completed"}]
REPORT >>> "CIAOCIAO\n\n— acme · default · cost: not reported"
CIAO occurrences: 2
error: expect(received).toBe(expected)
Expected: 1
Received: 2
(fail) PROOF: chunk + whole-text lastChunk reaches the report twice [2.90ms]
```

The mapper is right (`replace: true` on the second event); the report is wrong
(`CIAOCIAO`). Same script is the post-fix green test (see Tests).

## Implementation

*— claude-sonnet-5-5, 2026-11-26*

**Status: APPROVED** — the owner delegated the open decisions; each is recorded
below with its one-line reason.

### Load-bearing assumption

> Feeding the client the exact event sequence of the wire evidence yields the
> text **twice** in the final report, and the loss happens at `child.ts:449`,
> not in the mapper.

Proven twice, cited: (a) the repro above — the mapper emits
`{"kind":"output","text":"CIAO","replace":true}` (`a2a-map.ts:197`, verified by
the existing assertion `packages/agent/test/harness-a2a-map.test.ts:278-283`)
and the report still reads `CIAOCIAO`; (b) `replace` has **no** reader —
`rg -n "replace" packages/agent/src/harness/` returns only `types.ts:98-99`
(the declaration) and `a2a-map.ts:197,310` (the producer), never a consumer. So
the fix must plumb REPLACE into the report; a mapper-side dedupe (`emit nothing
when the text is unchanged`) would fix our pairing only and is rejected.

### Preconditions

- The mapper already tracks per-artifact text (`a2a-map.ts:100-101,106`) and the
  artifact id is in scope where the events are built — `a2a-map.ts:301-311`.
- One place assembles the report for **every** adapter: `child.ts:448-455` (the
  `output` case) writing the local `report` (`child.ts:189`), read at
  `child.ts:528-539`. Non-A2A adapters emit `output` without `replace`, so an
  additive, optional field cannot disturb them.
- `HarnessEvent` is harness-internal, not a `@tentacle/protocol` schema: adding an
  optional field is **not** a protocol break and needs no `protocol.d/` note
  (`packages/protocol` does not import it).
- The daemon's trailing whole-text artifact is *already* pinned:
  `packages/daemon/test/a2a-executor.test.ts:279-302` asserts the last
  `artifactUpdate` is the complete text with `append:false, lastChunk:true`. The
  server-side decision below therefore changes no daemon code and no pin.
- A terminal `task` snapshot's artifacts are deduped against what was streamed
  (`a2a.ts:216-223`) — only a *differing* snapshot still reaches
  `partEvents(state, a.parts, false)` (`a2a-map.ts:269`), and that path has the
  same defect class (it appends a full artifact over its deltas).
- Our daemon never emits a `message` stream response (`rg "AgentEvent\.(message|task)\("
  packages/daemon/src/a2a/` → only `task`), so the `message` case
  (`a2a-map.ts:276-279`) is a remote-only residual — see Failure modes.

### Design

Honour A2A `append:false` as **REPLACE, all the way to the report**, with the
per-artifact bookkeeping in a pure module (AGENTS §7: components/renderers stay
dumb; logic is tested where it lives).

1. **`HarnessEvent` output gains provenance** (`types.ts:95-106`):
   `readonly fromArtifact?: string` — the A2A `artifactId` this text came from.
   Name chosen over `artifactId` because its only meaning is "replaces the text
   *of the artifact this came from*" and it pairs with the existing `replace`
   flag. The declaration becomes: `replace` = "this event's text REPLACES that
   artifact's text so far (A2A `append:false`); `fromArtifact` says which".

2. **`a2a-map.ts` emits a REPLACE, then the content** (`:301-312`): keep
   `state.artifacts` bookkeeping as is, but express replacement explicitly
   instead of a flag the consumer cannot act on:

   ```ts
   const replace = !u.append && prev !== "";   // `has()` at :310 is dead: :308 just set it
   return [
     ...(replace ? [{ kind: "output" as const, replace: true, fromArtifact: a.artifactId }] : []),
     ...partEvents(state, a.parts, a.artifactId),
   ];
   ```
   `partEvents` (`a2a-map.ts:188-215`) loses its `replace` parameter and stamps
   `fromArtifact` on every event it emits (text, data, file). Consequence: an
   `append:false` update carrying **no** parts still clears the artifact (the
   daemon really emits that — `executor.ts:631-634` sends `parts: []` when the
   unit's text is empty but deltas were streamed). The `task` branch
   (`a2a-map.ts:269`) passes the artifact id too and replaces when the artifact
   was already seen (`state.artifacts.has(a.artifactId)`), because a snapshot
   **is** the artifact's full content, and updates `state.artifacts` with it.

3. **New pure module `packages/agent/src/harness/report.ts`** — the report as
   ordered segments (`{ id: string; text: string }[]`, `id: ""` = the plain
   tail): `createReport()`, `applyOutput(buf, ev)` (a `replace`+`fromArtifact`
   event empties that segment, then text/data/file append to it; the data line
   and the `[file] …` line move here from `child.ts:450-454`, so the buffer is
   the one place report text is composed), `appendReport(buf, text)` (notices),
   `setReport(buf, text)` (the two reset sites), `reportText(buf)`.
   Invariant that keeps every existing test honest: **with no `replace` event the
   joined segments are byte-identical to today's `report +=` concatenation** —
   a new order-preserving behaviour, not a reformat.

4. **`child.ts` uses the buffer** — `report` (`:189`) becomes `createReport()`;
   `:194` `reportText(report)`; the two resets `:265` and `:424` become
   `setReport(...)`; `:449-454` becomes `applyOutput(report, ev)`; the notices
   `:425, :494, :499, :516-517` become `appendReport(...)` (`:499`'s
   `!report.includes(end.text)` reads `reportText(report)`); `:528` reads
   `reportText(report).trim()`. Nothing else in the runner changes: framing,
   footer, worktree note and the empty-report fallback stay verbatim.

5. **Server: no change.** `endWithUnit` keeps publishing the whole text as
   `append:false, lastChunk:true` (`executor.ts:624-641`). Reasons: it is legal
   A2A and the only in-stream reconciliation for a client that missed deltas
   (`publishChunk` deltas are best-effort, `executor.ts:565-578` +
   `mapping.ts:279-281`); it makes the terminal artifact self-contained for
   `GetTask`-only readers; and removing it would mask a client bug that any
   other compliant server re-exposes. The pin at
   `a2a-executor.test.ts:279-302` becomes the guard on that decision.

#### Orchestrator decisions

The owner delegated every open question; each is the recommended option:

| # | Question | Decision | One-line reason |
|---|---|---|---|
| D1 | Where to fix | **Client** — honour `append:false` in the report | The wire shape is legal A2A; a server-side workaround leaves us non-compliant against every other compliant server (AGENTS §7). |
| D2 | How REPLACE reaches the report | **Pure per-artifact report buffer** (`report.ts`) | The consumer needs to know *which* artifact's text to retract; a flat string cannot, and logic belongs in a pure module (§7). |
| D3 | New event field | **`fromArtifact?: string`, additive** | Provenance is what `replace` lacks; optional and A2A-only, so no adapter, protocol or persistence surface moves. |
| D4 | Empty-parts `append:false` (a clear) | **Emit an explicit clear event** | Our own daemon sends `parts: []` (`executor.ts:631-634`); ignoring it leaves stale text in the report. |
| D5 | Terminal `task` snapshot carrying an artifact already streamed | **Replace it, not append** | A snapshot *is* the full artifact; `dedupeTask` (`a2a.ts:216-223`) already drops the equal case, so only the differing case remains — the same duplicate. |
| D6 | Server's trailing whole-text `lastChunk` | **Keep** (no daemon change) | Legal, self-contained, and the only in-stream reconciliation; the duplicate is a client bug and is pinned by `a2a-executor.test.ts:279-302`. |
| D7 | 64 KiB output cap accounting on a replacement | **Accept the over-count** | The replaced chars were already counted; today's duplicate burned the cap twice, so this is strictly no worse and the cap stays a bound. |
| D8 | `message` payload after streamed artifacts | **Leave as append, logged as debt** | Our daemon never emits `message`; deduping a remote `Message` needs a rule the spec does not give. |
| D9 | Test seam for the report | **Buffer unit tests + the existing runner seam** (`harness-remote-fit.test.ts`) | The bug lives in the seam, so the regression test must drive the real runner, not a copy of its logic. |

### Files

In dependency order (protocol untouched; no daemon change):

1. `packages/agent/src/harness/types.ts` — `fromArtifact?: string` on the
   `output` event + the `replace` doc (`:95-106`).
2. `packages/agent/src/harness/report.ts` — **new** pure module (~55 lines).
3. `packages/agent/src/harness/a2a-map.ts` — `:301-312` explicit clear + content
   events; `partEvents` `:188-215` takes the artifact id (drops `replace`);
   `:269` task-snapshot replace; drop the dead `has()` conjunct at `:310`.
4. `packages/agent/src/harness/child.ts` — the buffer at `:189,194,265,424-425,449-454,494,499,516-517,528`.
5. `packages/agent/test/harness-report.test.ts` — **new**, pure buffer tests.
6. `packages/agent/test/harness-a2a-map.test.ts` — update `:278-283`, add the
   clear-event and task-snapshot cases.
7. `packages/agent/test/harness-remote-fit.test.ts` — the report-level
   regression + the mapper→runner composition (this file already owns the seam
   and the `ScriptRun` fake, `:46-172`).
8. `changelog.d/a2a-stream-duplicate.fixed.md` — **new** (bullet above).

### Failure modes

- **Server closes with an empty artifact** (`executor.ts:631-634`:
  `parts: []`, `append:false` when a cancelled/dropped unit streamed deltas):
  today the deltas silently stay in the report; with D4 the segment is emptied and
  the report equals the artifact. If nothing else was said, the existing
  empty-report fallback speaks (`child.ts:530-533`). *Converges: report == artifact.*
- **An artifact replaced after another artifact was touched** (interleaved
  ids): segments are keyed by id, so only that artifact's text is rewritten and
  the order of first appearance is kept. Pinned by a test.
- **`replace` with no `fromArtifact`** (an adapter bug, or a future producer):
  the buffer clears the plain tail rather than dropping text silently; the A2A
  map always sets both, pinned by a map test.
- **64 KiB cap** (`takeText`, `a2a-map.ts:169-186`): a replacing stream counts
  the retracted chars again, so it can hit the cap a little earlier; `truncated`
  stays one-way and the note is unchanged (D7). No content is lost that the cap
  did not already bound.
- **Reattach after a drop** (`a2a.ts:216-223`): a `getTask` artifact whose text
  equals what was streamed is dropped; a differing one now **replaces** instead of
  appending — the duplicate cannot come back through the reattach path.
- **A remote `Message` after streamed artifacts** (`a2a-map.ts:276-279`): still
  appends (D8, debt). Not reachable from our daemon; if a peer does it the parent
  sees the text twice, and the follow-up is a `Message`↔artifact dedupe.
- **Non-A2A adapters** (`output` without `replace`/`fromArtifact`): append to the
  plain tail — byte-identical report to today; pinned by the buffer's
  concatenation invariant and by the untouched `harness-process` /
  `harness-claude-code` suites.
- **Version skew / older peer**: none — the field is harness-internal; no RPC
  frame, no `PROTOCOL_VERSION` change, no `protocol.d/` note.

### Tests

Red before green, on both sides (§9). The client tests are red on current code;
the server "test" is a **pin**, not red→green, because D6 changes no code — said
plainly here so nobody mistakes it for proof of a fix.

| Test | File | Property | Before fix |
|---|---|---|---|
| `report: replace rewrites only its artifact` | `harness-report.test.ts` (new) | `[{id response,"Ot"},{id response,"tarina-42"},{id response,replace→"OT-42"}]` → `"OT-42"`, other segments untouched | n/a (new module) — non-vacuity by mutation: make `applyOutput` ignore `replace`, it fails |
| `report: no replace → byte-identical concatenation` | same | appends in order, incl. data/file lines | green both (guards against reformatting the report) |
| `report: an empty replacement clears the segment` (D4) | same | `replace` with no content → `""` | n/a — mutation: emit the clear but ignore it |
| `artifactUpdate: append:false emits a clear event then the parts` | `harness-a2a-map.test.ts` (update `:278-283`) | events carry `fromArtifact: "a1"`, clear first | **red** (today: one event with a `replace` flag) |
| `artifactUpdate: no parts + append:false clears` | same | one `{replace:true, fromArtifact}` event | **red** (today: `[]`) |
| `task: an artifact already streamed is replaced, not appended` (D5) | same | snapshot with differing text → clear + text | **red** |
| `a2a: chunk + whole-text lastChunk → the report has it once` | `harness-remote-fit.test.ts` — **the repro above, verbatim** (`mapStreamResponse` → `ScriptRun` → `result.report`) | `CIAO` occurs exactly once | **red** (`CIAOCIAO`, pasted in Context) |
| `a2a: append:true deltas still concatenate` | same | two deltas → `"Ottarina-42"` once | green both (the anti-overreach pin) |
| `a2a: an artifact replaced mid-stream` | same | `"Ot"` + `"tarina-42"` + replace `"OTTARINA-42"` → the replacement only | **red** (today: `Ottarina-42OTTARINA-42`) |
| `stream: the final round replaces (whole artifact)` | `packages/daemon/test/a2a-executor.test.ts:279-302` | pin already exists — stays green, guards D6 | green (pin) |

Every red case is first shown failing on `main` with the exact output pasted into
Execution. Run narrow per slice (§4): `bun test packages/agent/test/harness-report.test.ts`,
then `packages/agent/test/harness-a2a-map.test.ts`, then
`packages/agent/test/harness-remote-fit.test.ts`, then the daemon a2a file; full
`bun run check` before done.

## Execution

*— pending: not written by the planner*

## Review

*— pending: not written by the planner. Per the metadata block the change is
`cross-module` but not `load-bearing`, so standard in-context Review — with the
adversarial checklist of AGENTS §10: re-run `bun run check`, re-run the Context
repro, and confirm the mutation checks in Tests are actually red.*
