# fix/mobile-open-long-session-3 — a ~400-message session opens at a middle turn and visibly scrolls to the end (round 3)

> **Status:** execution
> **Branch:** `fix/mobile-open-long-session-3`
> **Size:** S · **Blast:** contained (mobile transcript list, `follow.ts` + one FlatList prop) · **Suited:** weaker model executes, standard Review
> **Changelog:** `changelog.d/mobile-open-long-session-3.fixed.md`

## Context

*— claude-sonnet-5-5, 2026-11-25*

Round 2 (`mobile-open-long-session-2.md`) fixed the 114-row case. Post-merge QA (`.tentacle/tmp/qa-2411b/REPORT.md` §1b) found a ~400-message session opening blank ~0.6 s, then showing turn ~123 and scrolling down to the end over ~3.6 s: the contract "the end shows at once, no visible travel, at any length" is not met.

**Repro (main, sim 0B43D716, alpha filled to 400 msgs, last «turn 200 alpha», Maestro open + `simctl recordVideo`, frames at 10 fps):** `.tentacle/tmp/mobile-open-long-session-3/red-sheet-400.png` — blank, then the list at turn 82, then turns 82→200 sliding by over many frames. Reproduced on the first run.

**Characterisation.**
- Trigger: opening from the list. Magnitude: proportional to length (a window of rows not rendered yet), not a fixed px, not the composer inset.
- The transcript is a plain `FlatList` (`SessionScreen.tsx`, no `getItemLayout`, default `maxToRenderPerBatch` = 10). Scrolling to the end of a hidden list renders ~10 more rows per batch, each batch moves the content height, and the landing takes one measurement per move.
- `LANDING_ROUNDS` = 12 (`follow.ts`): ~120 rows. A long opening hits the bound (round 2's `capped` branch, then the quiet timer reveals) while the window is still filling; the rest then arrives with the list SHOWN and is followed by `contentGrew`, ANIMATED. That is the travel. This is inherited from round 1's bound (`df358162`), not from round 2: round 2 only changed the tick of the reveal (inferred from the code; df358162 was not run).
- Blank growth (QA §1a, 3.5 s on 114 rows): **not reproduced**. On this build, unloaded by anything but Maestro + video, the blank is ~0.5 s on 400 rows (5 frames at 10 fps before the first row). Not measured without any driver; the 3.5 s was most likely driver + video load.

## Implementation

*— claude-sonnet-5-5, 2026-11-25*

**Load-bearing assumption.** The growth steps are FlatList render batches, so bigger batches while hidden finish the window within `LANDING_ROUNDS`. Falsifiable: 400 rows open with no intermediate frame (done, see Execution).

**Design.** `follow.ts` `landingBatch(settling)` (pure) returns `LANDING_BATCH` (240) while the list is hidden, `undefined` (the FlatList default) once shown. `SessionScreen.tsx` passes it as `maxToRenderPerBatch`. No history-loading change, no bound change. **Mechanism (corrected in Fix round 1):** when the scroll target lies past the rendered window, `VirtualizeUtils.js:144-149` (`@react-native/virtualized-lists` 0.88) renders the LAST `maxToRenderPerBatch + 1` rows in one pass, whatever `windowSize` is; with 240 that is 241 rows at once while hidden, which is why a long opening lands in few rounds. `windowSize` does not bound that pass (the next pass trims). Cost: one long hidden JS stall, so a longer blank on a slow device.

**Files.** `apps/mobile/src/follow.ts`, `apps/mobile/src/screens/SessionScreen.tsx` (1 prop), `apps/mobile/test/follow.test.ts`, `changelog.d/mobile-open-long-session-3.fixed.md`.

**Failure modes.** Very long (1000+) sessions: the window, not the count, bounds rendering; if the growth still outlasts 12 rounds the old capped/tail path applies (unchanged, travel possible again — not measured beyond 400). Growing while opening: unchanged path. Short sessions: never above 10 rows per batch anyway. Re-open/re-attach: `settling` false → default batching. Rotation: after reveal, default. Cost: one hidden render pass of ~241 rows on the JS thread (even when they span far more than 21 viewports, e.g. code/diagram rows), i.e. a longer blank on a slow device — not measured.

**Tests.** `follow.test.ts` "landingBatch": hidden → `LANDING_BATCH`, shown/quiet → `undefined`; 

## Execution

*— claude-sonnet-5-5, 2026-11-25*

**Red → green.** Test red on the unmodified code (the new exports did not exist → the file failed to load, 0 pass); with the fix 71 pass / 0 fail. **Mutation:** `landingBatch` returning `undefined` always → 1 fail (70 pass); restored. Lint on the changed files clean.

**Simulator (iPhone 17 Pro Max, release build of this tree), `.tentacle/tmp/mobile-open-long-session-3/`:**
- before: `red-sheet-400.png` (blank → turn 82 → travel to 200).
- after: `green-sheet-400.png` (10 fps, last 27 frames: blank ~0.5 s, then turns 194–200 directly, no intermediate position), `green-long400.png` (400 msgs at rest), `green-alpha114.png` (114 msgs: turn 57 + answer above the composer), `green-charlie.png` (short session right).

**Unverified:** blank length on a slow device / with tall rows (241-row pass); sessions ≫ 400 rows; "proportional to length" (one length measured); blank length with no Maestro/video running; behaviour on a physical device (slower JS may need more than one batch).

## Review (Round 1)

*— claude-opus-5-5, 2026-11-25 (fresh context; executor claude-sonnet-5-5: different model, same Claude family, so blind spots may be shared)*

**Verdict: REQUEST-CHANGES**: two MEDIUM findings, both cheap to fix. The fix itself holds, and the simulator evidence supports it.

**Gate (this tree).** `bun run typecheck`: exit 0. `bun run lint`: 2395 files, clean. `bun run test` run 1: 17884 pass / 5 skip / **1 fail**. Run 2: 17885 pass / 5 skip / 0 fail. The failing test was not identified: the parallel runner's tail did not name it, and it did not recur. The diff is a pure function plus one FlatList prop, so it cannot plausibly cause a failure outside the mobile list. The 5 skips are 2 more than the AGENTS §6 baseline of 3. The diff adds no skip, so they come from `main`.

**Findings**
1. **MEDIUM: the fix's wiring is not pinned by any test.** In place, I deleted `maxToRenderPerBatch={landingBatch(settling)}` (`SessionScreen.tsx:1836`) and ran `bun test` in `apps/mobile`: **5022 pass / 0 fail**. I restored the file and its shasum matched. The new tests pin only the pure helper. Test 2 (`LANDING_BATCH >= 200`) restates a constant. "Red on main" was red only because the import did not exist, not because the behaviour was wrong. This is not a §9 regression test. Fix: add a source pin to `apps/mobile/test/session-screen-follow-wiring.test.ts`, which already pins the landing wiring that way. It must fail when the prop is removed or passed a constant.
2. **MEDIUM: false premise in Implementation/Design.** The Design says "nothing rendered that the window would not render anyway (the default `windowSize` 21 bounds it)", and the test comment says "the batch covers a whole window". Neither holds for the branch this fix relies on. In `VirtualizeUtils.js:144-149` (`@react-native/virtualized-lists` 0.88), when the scroll target lies past the rendered window ("entire list is before our overscan window"), the list renders the **last `maxToRenderPerBatch + 1` rows**, whatever `windowSize` is. With 240, that is 241 rows in one JS batch while the list is hidden, even when those rows span far more than 21 viewports (code or diagram rows); the next pass trims them. This is probably the real reason 400 rows land in one step, so the mechanism text should say so. Its cost (one long hidden JS stall, so a longer blank on a slow device) should sit under Failure modes and Unverified, not be ruled out. Fix the doc and the test comment; the code can stay.
3. LOW: the mechanism is shown by intervention (N=1 red, N=1 green, `red-sheet-400.png` / `green-sheet-400.png`: red shows turn 82 → 200 travel, green shows blank → 194–200 with no intermediate frame), not by instrumentation. Nothing logged `capped`/`rounds` reaching `LANDING_ROUNDS` on the red run. The "~570 px gap" in my brief is the round-1 symptom (`mobile-open-long-session.md`). This round's symptom is travel. The cause explains the travel: the bound expires mid-growth and the rest arrives through `contentGrew` animated. "Proportional to length" was inferred, not measured at two lengths.
4. LOW: re-attach, resync, pull-to-refresh and Reopen start from `landingQuiet` (`settling: false`), so they keep 10-row batches. If a resync re-keys a long list (cf. `mobile-foreground-jump.md`), the same mid-growth travel can recur on the shown list. This predates the diff and is out of scope; record it in Notes.

**Mutation.** (a) Prop removed from `SessionScreen.tsx`: 0 fail. That is finding 1. (b) `landingBatch` always returns `undefined`: follow.test.ts 70 pass / 1 fail, which matches Execution's claim. Both files were restored and shasums verified. `git status` is clean.

**Premise table**
| Premise | Verdict |
|---|---|
| Red: 400 msgs open at a middle turn and visibly travel to the end | TRUE (`red-sheet-400.png`, turn 82 → 200 over ~13 frames) |
| FlatList default batch 10, growth one batch per update | TRUE (`VirtualizedList.js:650-653`, `computeWindowedRenderLimits` caps `newCellCount` at `maxToRenderPerBatch`) |
| `LANDING_ROUNDS` = 12, capped path then tail follows animated | TRUE (`follow.ts:255`, `:349-372`) |
| `windowSize` bounds what a 240 batch renders | **FALSE** for the jump branch (`VirtualizeUtils.js:144-149`), finding 2 |
| Short sessions unaffected | TRUE (≤ 10 rows already render in the initial batch; `green-charlie.png`) |
| Prior constraint "keep virtualization, no `initialNumToRender = rows.length`" (`mobile-open-at-end.md:76`) | HOLDS: virtualization is on; only the per-batch cap rises, and only while hidden |

**Attacks tried**
- *Very long (1000+) sessions:* the jump branch renders the last 241 rows; if those do not reach the window edge, further batches of 240 follow, so convergence should take a few rounds and stay well under 12. Not measured. Cost risk: finding 2.
- *Content growing while opening:* `settling` drives the prop and the landing machine is unchanged. The batch drops to default at reveal. Nothing new.
- *Reveal transition (240 → default):* the prop change re-runs `computeWindowedRenderLimits` against the large previous window. It trims only outside overscan, so the visible end does not move. No visible travel.
- *Rotation / keyboard / composer inset:* after reveal `settling` is false and the prop is `undefined` (the default). `viewportChanged` is untouched.
- *Re-open / re-attach:* the default batch applies, which is finding 4.
- *Logic in pure module:* yes. `landingBatch` lives in `follow.ts`, and the component maps it to a prop. That follows §7.
- *No new visible scroll travel:* green shows no intermediate position, and nothing scrolls while shown.

**What holds.** The diagnosis and the one-prop fix are sound and minimal. The pure-module split is right. The changelog fragment is well formed. The simulator red/green evidence is real and checks the exact property: no intermediate frame.

**Executor behaviour.** Execution is honest and compact. It names its unverified parts (≫400 rows, no-driver blank, physical device) and does not overclaim the 3.5 s blank. Weaknesses: it presented a red-by-missing-import as red, left the only behavioural line unpinned, and stated the windowing premise without reading `VirtualizeUtils`.

### Fix round 1

*— claude-sonnet-5-5, 2026-11-25*

- **MEDIUM 1 (wiring unpinned):** added a source pin in `apps/mobile/test/session-screen-follow-wiring.test.ts` (`<FlatList … maxToRenderPerBatch={landingBatch(settling)}` + the import). **Red:** with the prop replaced by `{10}` → 1 fail; with the prop removed → 1 fail (93 pass each); restored → 94 pass / 0 fail (`follow.test.ts` + wiring). No render change, so no new simulator run.
- **MEDIUM 2 (false windowSize premise):** Design/Failure modes above now state the real mechanism (the jump branch renders the last `maxToRenderPerBatch + 1` rows) and its cost; the follow test comment/assertion no longer claims "covers a whole window" and asserts only `LANDING_BATCH >= LANDING_ROUNDS * 10`. Code unchanged.
- **LOW 3:** the mechanism is shown by intervention (N=1 red/green), not instrumentation; recorded under Unverified.
- **LOW 4 (Notes):** re-attach / resync / Reopen start from `landingQuiet` (`settling: false`) and keep 10-row batches; a resync that re-keys a long list could show the same mid-growth travel on the shown list. Pre-existing, out of scope; follow-up candidate.
