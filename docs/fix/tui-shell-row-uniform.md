# fix/tui-shell-row-uniform — one shape for every tool row (TUI): no repeated outcome, command inside the `⎿` block

Type: fix · Size: S–M · Blast: contained (TUI rendering only) · Suited: DeepSeek exec + Opus review

## Context

Owner 2026-11-22 ~01:35 (screenshot of a TUI turn with three shell rows that carry an intent sentence): since feat/shell-intent-line the rows lost uniformity and repeat themselves:
1. the title shows `✓ 0.0s` / `✗ exit 1 0.2s` AND the body shows `⎿ exit=0` / `exit=1` — a repetition: «togliamolo»;
2. the command sits on its own line ABOVE the `⎿` block (`  │ $ memory_pressure …`), a shape no other tool row has, and misaligned.

Today (real frames, main 1791d22b):
```
● Uso memoria ✓ 0.0s
  │ $ memory_pressure 2>/dev/null | tail -3; echo ---; vm_stat | head -5
⎿ exit=0
  Pageouts: 77
```
Owner chose variant **B** (accepted directly, 01:45), shown to him as plain text:

compactShell OFF:
```
● Uso memoria 0.2s
⎿ $ memory_pressure 2>/dev/null | tail -3; echo ---; vm_stat | head -5
  Pageouts: 77

● Container in esecuzione 0.2s
⎿ $ podman ps 2>&1; echo ---; docker ps 2>&1
  exit=1
  Cannot connect to Podman. Please verify your connection …

● Read note/demo-agent.md 0.0s
⎿ # Demo agent
  Un agente che legge.
```
compactShell ON (beta): a successful shell row drops the `$` line, so `⎿` starts the output; a successful command with NO output is the title line alone; a failed one is shown in full (same as OFF):
```
● Uso memoria 0.2s
⎿ Pageouts: 77
  System-wide memory free percentage: 90%

● Creo la cartella dei log 0.0s

● Container in esecuzione 0.2s
⎿ $ podman ps 2>&1; echo ---; docker ps 2>&1
  exit=1
  Cannot connect to Podman. Please verify your connection …
```
Rules: no `✓` and no `✗ exit N` in ANY tool title (shell with or without intent); duration stays. `exit=N` is printed only when N ≠ 0 (as the first line after the `$` line). The `$ command` line is the first line of the `⎿` block, dimmed like today's command text; output follows at the block's indent (col 2). Edit/Write/Read rows unchanged (they already have this shape). The expanded view (ctrl+o) and the permission ask keep the verbatim command (the ask is a security rule of shell-intent-line — do NOT touch it). Colour-blind owner: success = no `exit=` line, failure = `exit=N` in text; colour only reinforces. Rows WITHOUT an intent sentence (`● Bash <cmd> 0.2s`) follow the same exit rule (no `exit=0`), the command stays in their title as today.
Phone: out of scope (owner said «da terminale»).

*— claude-opus-5-5 (orchestrator), 2026-11-22*

## Implementation

- Load-bearing assumption: all of this is decided in the pure TUI row builder (`packages/tui/src/render-lines.ts`, `itemLines` / the tool-row + shell-intent branches added by feat/shell-intent-line, and the compactShell gate). Verify by `rg -n "exit=|✓|compactShell|│ " packages/tui/src` before editing and cite file:line in Execution.
- Change only the view builder (pure); components untouched. Keep the blink OFF phase (`offPhaseRows`) working: the running row (no outcome yet) is unchanged.
- Tests (red on main first, then green): snapshot-style line tests for the four cases above (intent ok / intent fail / compactShell ok with output / compactShell ok without output) + a plain `Bash` row ok (no `exit=0`) + a failed plain `Bash` row (`exit=1` kept). Update existing tests that pinned `✓` / `exit=0` / `│ $`; say which in Execution. Also check `scripts/mockup-kit` TUI cases still generate (`bun run mockup-kit`) if they snapshot these rows.
- changelog.d/tui-shell-row-uniform.changed.md (one bullet).

## Execution

Load-bearing check re-run FIRST (Implementation says all of this is decided in the pure row builder): `rg -n "exit=|✓|compactShell|│ " packages/tui/src` on branch `fix/tui-shell-row-uniform` (off `main` 1791d22b) → the tool-row shape lives in `packages/tui/src/render-lines.ts` (PRE-change line numbers, as observed before editing): `toolLines:922` (the `shell` dispatch), the `compactShell` gate `:944`, `shellIntentLines:1002` (the described row), `toolBodyRows:973` (the `⎿` connector), `plainToolBody:584` (the body text, `:660`), `spillParts:507` (a spilled head); the parts themselves in `packages/core/src/shell-intent.ts` (`shellOutcome:80`, `shellRowParts:104`). The assumption holds — the components only paint.

Repro (`.tentacle/tmp/tui-shell-row-uniform/repro.ts`, AGENTS §6), BEFORE the change: `● Uso memoria ✓ 0.2s` / `  $ memory_pressure …` / `⎿ exit=0` / `  Pageouts: 77`; the fail row repeats `✗ exit 1` in the title AND `⎿ exit=1`; `compactShell` on a success still showed `✓` and `⎿ exit=0`. Reproduced on the branch — the same frames the Context records. AFTER: the owner's variant B exactly (`● Uso memoria 0.2s` / `⎿ $ memory_pressure …` / `  Pageouts: 77`; fail: `  exit=1` / `  Cannot connect …`; compactShell success: `⎿ Pageouts: 77`, and with no output the title line alone).

Changes, in dependency order:

1. **`packages/tui/src/render-lines.ts` — the row builder (the only production change).**
   - `shellIntentLines:1037`: the title drops the outcome entirely — `shellOutcome` is no longer called there (the import is gone from this file; `shellOutcome` stays in `core` for the PHONE, `apps/mobile/src/tool-steps.ts:380`, which is out of scope by the owner's "da terminale"). Row 0 is `● <bold sentence><elapsed>`; the budget no longer reserves outcome cells.
   - `shellIntentLines`: the `$ <command>` row is now **the block's first line**, built with `connector()` (`⎿ $ …`) instead of `INDENT` (`  $ …`), so the command sits inside the block and the output follows at the block's indent (col 2). With the `$` row hidden (`compactShell` on a running/success row), the body's own first line takes the connector. That split is why the old `toolBodyRows` (pre-change `:973`) became `toolBodyLines:1000` (the cut body, no prefix) + `bodyRows:1020` (the `⎿`/`  ` prefixes), with `toolBodyRows:995` the composition — byte-identical for every other tool.
     The same connector applies to a QUEUED described row (`◌ <sentence> · queued` / `⎿ $ cmd`), which the Context does not discuss: keeping the old `  $ ` there would have left two shapes in the same list, so the block shape is uniform from `queued` onwards. Recorded as a test.
   - `plainToolBody:588` (`:663`) + new `shellBodyText:687`: a `shell` result's text is filtered through `shellExitCode` — `exit=0` is dropped (a success writes nothing), a non-zero code stays as the block's first line. An emptied body returns `[]`, never a bare `⎿`. (`shellExitCode` is the same predicate `shellOutcome` used, so the parse cannot drift.)
   - `spillParts:507` (`:518`): the same filter on a spilled result's head, so a spill whose preview starts `exit=0` does not re-introduce the contradiction the fix removes. The code a failure is read from is the same head, so a spilled failure keeps `exit=N`.
   - `offPhaseRows`/the row cache/`compactShell` in the cache key: untouched, and the blink tests are green.

2. **Tests (red first, then green).** `packages/tui/test/shell-intent-rows.test.ts` — the four shapes the Context names, plus the failure modes: a spilled success *and* a spilled failure, a denial (no invented code), `exit=124`/`exit=-1`, a background start (no `exit=`), the no-output success, the multi-line command, a plain `Bash` ok (no `exit=0`) / fail (`exit=1` kept) / expanded, queued. `packages/tui/test/app-shell-intent.test.tsx` — the same at the Ink seam: `⎿ $ cmd` while running, NO `✓` and NO `exit=0` when settled, the input row does not move.

   **RED on the buggy code, before the fix:** `bun test packages/tui/test/shell-intent-rows.test.ts` → `3 pass · 12 fail` (the failures are the assertions of the property: `"  $ bun test apps/mobile"` received where `"⎿ $ …"` was expected; `⎿ exit=0` + `  all good` where `⎿ all good` was expected). GREEN after: `17 pass · 0 fail`. (`app-shell-intent.test.tsx` was updated after its first red run and verified green post-fix only: `1 pass · 11 expect()`; it asserts `⎿ $ cmd` while running and `not.toContain("✓")`/`exit=0` when settled, both of which the mutation table shows are killed by the old shape.)

   **Existing tests updated (they pinned the old shape):** `shell-intent-rows.test.ts` — "settled ok: the header WRITES ✓ …", "error exit=2: the header WRITES `✗ exit 2`", "a denial writes ✗", and the `compactShell` "running / ok → 1 row" case; the `describe` whose comment claimed the no-sentence rows stay "byte-identical" now pins the new exit rule too (`⎿ all good`, not `⎿ exit=0` + `  all good`). `app-shell-intent.test.tsx` — its header comment and its two `✓`/`  $ cmd` assertions.

   `scripts/mockup-kit` regenerated (`bun run mockup-kit`, 3 files) and **no TUI row changed** — its shell cases carry no `exit=` result (`scripts/mockup-kit/tui-cases.ts`), confirmed by a direct kit-data-vs-`itemLines` comparison (`.tentacle/tmp/tui-shell-row-uniform/kit-check.ts` → "no drift"), so `tools/mockup-kit/generated/` is untouched in the diff.

3. **`changelog.d/tui-shell-row-uniform.changed.md`** — one bullet (AGENTS §10).

Also: a pointer note added under `docs/feat/shell-intent-line.md` §3 (the section
this fix supersedes in part), so that doc does not read as current. No code in
`packages/core` or `apps/mobile` changed: `shellOutcome` stays (the phone's
`apps/mobile/src/tool-steps.ts:380` still uses it — "out of scope, da terminale"
in the Context), it is just no longer imported by the TUI.

Mutation checks (the plan's targets; each run, then reverted, then the suite re-run green):

| Mutation | Target | Result |
|---|---|---|
| `shellBodyText` returns `text` unchanged (keeps `exit=0`) | the exit rule | **6 fail** — the two intent ok cases, the no-output success, the spill case, the two `compactShell` successes, the plain-`Bash` block |
| the title re-paints `✓` on `ok` | "no outcome in ANY tool title" | **8 fail** (7 row tests + the App seam test) |
| the `$` row back on `INDENT` (`  $ cmd`, outside the block) | "the command is the block's first line" | **≥10 fail** — every collapsed described-row case, the plain-`Bash` block and the App test (the output list was cut by `head`, so the exact count was not read) |
| the emptied shell body returns `[""]` instead of `[]` | "a success with no output is the title line alone" | **3 fail** |

Validation run: `bun test packages/tui/test` → **2942 pass · 0 fail** (208 files, 47 snapshots); `bunx biome check` on the three changed files → clean. Drift from the Implementation: none in the Design; the Implementation's "say which tests you updated" is answered above. Protocol/persistence untouched (display-only, `PROTOCOL_VERSION` unmoved, no `protocol.d/` note needed: no wire change — the TUI derives everything from `resultText`/`spill` it already receives).

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 (executor), 2026-11-22*

## Review

**Verdict: APPROVE-WITH-NITS** (no HIGH/MEDIUM findings). Scope: `git diff main...HEAD`.

Gate (what I ran): `bun test` on the touched files `shell-intent-rows.test.ts` + `app-shell-intent.test.tsx` + `cli/test/local-runtime.test.ts` → **97 pass · 0 fail** (386 expect); `bun run lint` → clean (2252 files); `bun run typecheck` → clean. I did NOT run the full `bun test`; the orchestrator's merge-time `bun run check` covers that.

Premises: `render-lines.ts` is the only production change, and it is pure (TRUE). `shellExitCode` (`core/src/shell-intent.ts:67`) is the same predicate `shellOutcome` used (TRUE). `shellOutcome` is still used by the phone (`apps/mobile/src/tool-steps.ts:380`) (TRUE, out of scope). No protocol or persistence change (TRUE: display-only, so no §7 wire or persistence invariant is touched).

Mutations (temporary edits, reverted; `git status` clean afterwards):
- spill head left unfiltered (`render-lines.ts:521`) → 1 fail (the spilled-success test);
- body under `$` given its own `⎿` (`render-lines.ts:1068`) → 6 fail.

My attempt to re-run the executor's M1/M3/M4 as a script was blocked by permissions, so for those I rely on the Execution table.

Attacks tried:
1. Blink OFF phase with the new `⎿ $` row 1: `offPhaseRows:1356` swaps only row 0's bullet. Holds.
2. Expanded view: `commandRow` is empty when expanded, so the output is `  │ $ …` rows, then a body opening on its own `⎿`. Consistent.
3. Background, denial and spill: a non-`exit=` result keeps its text (`shellExitCode` returns null), and a spilled failure keeps its `exit=N` (but below the spill note, not directly under `$`; acceptable).
4. A plain-`Bash` running row is still `running…`. Unchanged.

Nits:
1. Commit `b54fee44` changes `packages/cli/test/local-runtime.test.ts` (sleep → `eventually` poll). That is a flake fix unrelated to this task, and the Execution does not mention it. It is harmless, but it should be recorded or split out.
2. In a spilled shell failure, `exit=N` comes after the spill note, not as the first line under `$`. This is a minor deviation from the Context rule.

Executor behaviour: faithful to the plan. It reported red/green and the mutations honestly, and stated the scope (queued row) explicitly. Its only omission is nit 1.

Reviewer is a different model family from the executor (Opus vs DeepSeek).

*— claude-opus-5-5, 2026-11-22*
