# fix/mobile-step-thought-marker — no ∴ next to a command's duration

> **Status:** implementation approved (owner 17/11)
> Type: fix · Size: S · Blast: contained · Suited: DeepSeek exec + standard review

## Context
*— claude-opus-5-5, 2026-11-17*

Owner (17/11, device screenshot of the tool-step thread): Bash rows show `∴ 22 ms`, `∴ 592 ms`, `Chart … ∴ 0 ms` — the ∴ sits next to the command's duration. Owner: "i tre puntini di thought non devono stare di fianco al tempo impiegato per i comandi, ma solo per il ragionamento".

Today the ∴ after the subtitle means "a thought is folded into this step" (`StepNode.tsx:261-262` prop `marker`, set at `screens/transcript/TranscriptRow.tsx:444` as `marker={view.thought !== null}`). The folded thought itself stays visible when the row is opened (`StepNode.tsx:418-423`).

## Implementation
*— claude-opus-5-5, 2026-11-17*

- Load-bearing assumption: the ∴ marker on a tool step carries no information the open row does not already show (the folded thought renders in the body, `StepNode.tsx:418-423`). Verify by reading those lines.
- Design: a tool step NEVER shows the trailing ∴ marker; the ∴ stays only on Thought rows (the orphan-thought node, `TranscriptRow.tsx:~300-321`, and the live Thinking footer). Remove the `marker` prop from `StepNode` entirely if nothing else sets it to true (it is `false` at `TranscriptRow.tsx:321` and `StepNode.tsx:483`), with its style `styles.marker` (`StepNode.tsx:533`) — dead code otherwise.
- Files: `apps/mobile/src/ui/StepNode.tsx`, `apps/mobile/src/screens/transcript/TranscriptRow.tsx`, the tests that pinned the marker (rg -n "marker" apps/mobile/test).
- Failure modes: a test or e2e flow asserting the marker (`rg -n "thought-mark|marker" apps/mobile/e2e apps/mobile/test`) → update it to assert the ABSENCE on a tool step and the presence on a Thought row.
- Tests: red→green — a test that a tool step with a folded thought renders no ∴ marker on its line (fails on main), and the Thought row still shows its ∴.

## Execution
*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 (tentacle `deepseek` profile), 2026-11-17*

**Load-bearing check (re-run, held).** `apps/mobile/src/ui/StepNode.tsx:416-422`
(`StepBody`, the plan's `:418-423`) renders `<ThereforeDots/>` + the thought as its first item,
so the folded thought is visible with no trailing marker. Confirmed empirically, not just by
reading: a probe (`.tentacle/tmp/mobile-step-thought-marker/probe.test.ts`, gitignored)
called the real `TranscriptRow` → `ToolRowView` → `StepShell` → `StepNode` and printed, on
main:

```
tool+thought marker: true body.thought: "I should list the files"
tool plain marker: false
reasoning node: thought marker: false subtitle: "Weighing the options"
```

So the ∴ after a subtitle was purely redundant with the body. The `marker` prop is `true` at
exactly ONE of the three call sites (`TranscriptRow.tsx:444`); the other two pass `false`
(`TranscriptRow.tsx:321`, `StepNode.tsx:483`), so deleting it costs no information anywhere.
The plan's diagnosis held; the one drift is doc-only (below).

**As built (dependency order):**
1. `apps/mobile/test/step-thought-marker.test.ts` (new) — the regression test, written and
   shown RED first (6/6 fail on the assertion of the property, not on an import error: the
   tool row's `StepNode` props carried `marker: true`). It renders the REAL `TranscriptRow`
   one component at a time (`Shell`/`StepShell` are called, `StepNode` is not — it runs hooks),
   the `chart-view.test.ts` pattern, with a superset of that file's `react-native` stubs so
   Bun's first-mock-wins module shape does not break it. Four cases: a tool step with a folded
   thought (the absence of the marker AND, by walking into `StepBody`, the presence of the
   drawn thought + its own ∴ — mutation B below is what forced that second half), without a
   thought, a live (running, clock-ticking) command, and a Thought row (whose `node` is still
   `"thought"`), plus two source guards on `StepNode.tsx` / `TranscriptRow.tsx`.
2. `apps/mobile/src/ui/StepNode.tsx` — the `marker` prop, its `{marker ? <ThereforeDots …/>}`
   draw, its `styles.marker` and the `marker={false}` at the `ThinkingNode` call are gone
   (was: prop `:264`, draw `:367`, style `:531`). The header, `THEREFORE_SIZE` and
   `ThereforeDots` comments no longer call it "the row marker", and the file header says the
   line carries none. Left: exactly two `<ThereforeDots/>` (`:243` the thought's node,
   `:418` the folded thought in the body).
3. `apps/mobile/src/screens/transcript/TranscriptRow.tsx` — `marker={view.thought !== null}`
   (was `:444`) and `marker={false}` (was `:321`) removed. Nothing else in `apps/mobile/src`
   set it.
4. `apps/mobile/test/tool-rows-wiring.test.ts:109` — the one existing test that pinned the
   marker ("every ∴ (node, row marker, thought) is one size …" asserted
   `>= 3` `<ThereforeDots/>`). It now asserts exactly 2 (a thought's node, the folded thought
   in the body), which is a *stronger* pin than the old floor: re-adding a third ∴ anywhere
   in the file fails it.
5. `changelog.d/mobile-step-thought-marker.fixed.md` — one bullet.

**Failure modes (the plan's list), all covered:** no test or e2e flow asserted the marker on
a tool line (`rg -n "marker|∴|thought-mark" apps/mobile/e2e apps/mobile/test` — the only hits
were the wiring test above, `thinking-motion.test.ts`'s breathing node, and comments in
`e2e/flows/29-tool-rows.yaml`); the wiring test was updated as the plan required. The absence
is now asserted on a tool step (with/without a thought, running and settled) and the presence
on a Thought row (`node === "thought"`, i.e. that row's gutter ∴).

**Mutation checks (§9 non-vacuity).** Each run with the suite otherwise at its final state, the
mutation reverted right after.
- *Mutation A — re-add the marker* (a `marker?: boolean` prop, a `<ThereforeDots/>` after the
  subtitle, and `marker={view.thought !== null}` at the tool call): **5 of 6 fail** — all three
  tool-row cases plus both source guards. Reverted → 6 pass.
- *Mutation B — keep the marker out, break what the body draws* (the thought `<Text>` renders
  the literal `MUTATION B` instead of `thought`): the FIRST version of my test still passed,
  because it asserted the body's PROP (`body.props.thought`) rather than what the body DRAWS —
  a weaker correlated property, exactly the §2 trap. The test was strengthened to walk into
  `StepBody`: the first item is a `View` whose children are `[ThereforeDots, <Text with the
  thought>]`. Re-run against the same mutation: **that case fails** (`Expected: "I should list
  the files first", Received: "MUTATION B"`), 5 pass. Reverted → 6 pass.
- *(Final: `step-thought-marker` 6 pass, + `tool-rows-wiring` 21 pass together.)*

**Deliberately left:** `stepA11yLabel` (`tool-steps.ts:218`) still appends the spoken
"thought first" for a tool step with a folded thought. That is not the visual ∴ the owner
objected to — it is how a VoiceOver user learns the body opens with a thought, and removing
it would delete the only remaining signal for a mode that cannot see the body. No `StepNode`
style or layout dimension other than the removed marker changed (the line was already
`flexDirection: "row"` with `gap: 6`, and the trailing text was already `flexShrink`-free next
to a `flex: 1` subtitle).

**Drift (one, doc-only):** `docs/feat/mobile-tool-rows.md` (not in the plan's file list)
still described the line as "name, summary, an optional small ∴, duration" — in the summary
(`:28`), in "No Thinking rows" (`:31`) and in Design 3's drawn-line list. After this fix that
prose contradicted the code, so those three places are annotated as superseded, each pointing
at this doc; no other content changed (the doc's historical plan/decision sections are left as
the record of what was decided then).

**Gate:** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile` clean · `bun run lint` clean
(2013 files, 0 errors/warnings) · `bun test` (full, once): **14645 pass, 5 skip, 1 fail**. The
one fail is NOT this change's: `packages/daemon/test/serve-log-store.test.ts:922` (S11's
200-SIGKILL crash test) scored `loads 0; ` under the load of the full run — a machine-timing
flake in a file this branch does not touch (this diff is three `apps/mobile` files). Evidence
it is load: alone it is `22 pass / 0 fail` (15.4 s), and the whole `packages/daemon/test`
directory is `1383 pass, 1 skip, 0 fail`. The 5 skips are the opt-in ones —
`TENTACLE_DOCKER_TESTS` (2 files), `TENTACLE_K8S_SERVER` (2) and `TENTACLE_SLOW_TESTS=1`
(`ws-server`'s real socket) — i.e. the AGENTS §6 baseline; my new file's 6 cases are among the
14645 pass, as is the whole `apps/mobile` suite (`3026 pass / 0 fail`).

## Review

### Review (opus, paired)
*— claude-opus-5-5, 2026-11-17*

**Verdict: PASS.**

- **Owner's property holds.** `StepNode` has no `marker` prop, no `styles.marker` and
  no `<ThereforeDots>` on the line (`StepNode.tsx:363-366` goes subtitle → trailing);
  exactly two `<ThereforeDots>` remain: the `thought`/`thinking` node in the gutter and
  the folded thought in `StepBody`. Every call site that passed `marker` is gone
  (`TranscriptRow.tsx` ×2, `ThinkingNode` ×1). The Thought row still renders
  `node: "thought"` (its ∴ node), and the Thinking footer is untouched.
- **Red→green, re-run by me.** `step-thought-marker.test.ts` + `tool-rows-wiring.test.ts`:
  21 pass on HEAD. I swapped `StepNode.tsx` + `TranscriptRow.tsx` back to the merge-base
  (`84872bdf`; `main` itself has since moved on and its `TranscriptRow` no longer
  resolves on this branch): all 4 behavioural cases + both source guards + the wiring
  `=== 2` pin fail (`Expected: false / Received: true`). Reverted, tree clean.
- **Test strength.** The behavioural cases assert the prop is *absent* (`"marker" in
  props`), and the source guard pins the drawn count at exactly 2 — together they
  cover re-adding the ∴ by prop or by a hard-coded draw. The body walk (Mutation B)
  proves the folded thought is still visible, so nothing is lost.
- **Scope.** Production changes are limited to the two files; the
  `docs/feat/mobile-tool-rows.md` annotation is doc-only and disclosed as drift. The
  `stepA11yLabel` "thought first" is kept on purpose; I agree (it is the only signal a
  VoiceOver user gets, and the owner's complaint was visual).
- **Changelog** `changelog.d/mobile-step-thought-marker.fixed.md` is present, one bullet.
- **Gate (scoped per brief):** `bunx tsc -p apps/mobile` clean. Full suite not re-run
  here; the executor's single `serve-log-store` load flake is in an untouched package.
- **Executor behaviour:** honest. It caught and fixed its own weak assertion (Mutation B)
  instead of reporting the first green.
