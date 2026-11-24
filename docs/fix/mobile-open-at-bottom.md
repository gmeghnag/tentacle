# fix/mobile-open-at-bottom — opening a session shows the transcript already at its end, no visible scroll

> **Status:** context
> **Branch:** `fix/mobile-open-at-bottom`
> **Size:** S–M · **Blast:** contained (app transcript list) · **Suited:** Sonnet triage+plan → Sonnet exec, Opus review
> **Changelog:** `changelog.d/mobile-open-at-bottom.fixed.md`

## Context

Owner 24/11: «quando apro una sessione su mobile vedo tutto lo scroll fino in fondo (per caso fa così perché si carica tutta la conversazione e renderizza realtime?), ed è un po' fastidioso per gli occhi. Possiamo aprire direttamente in fondo la conversazione?»

Symptom: on opening a session the transcript visibly scrolls from the top (or from mid-way) down to the end. Expected: the first frame the user sees is already the end of the conversation (latest messages), no animated travel; later follow behaviour (new content while at the bottom, scroll-up to read) unchanged.

Leads (unverified): the transcript list is `apps/mobile/src/screens/SessionScreen.tsx` (~:1914 `onContentSizeChange={onContentSize}`, comment ~:545) driven by the pure follow module `apps/mobile/src/follow.ts` (:69 «Not RN's scrollToEnd…», :353). Likely the list renders the whole history and follow chases the growing content height (virtualized cells measured late, estimated heights), possibly animated. Candidate fixes to weigh: keep the list hidden/opaque-0 until the first settle at the end; jump without animation for the initial catch-up; `inverted` list; render the tail first (`initialNumToRender` from the end / `initialScrollIndex`). AGENTS §1: characterise first (trigger: cold open vs reopen vs resume; magnitude: how far it travels; does it depend on transcript length?) — a simulator frame sequence or a follow.ts unit repro of the initial catch-up. If you use the simulator take `sim.lock` (`.tentacle/tmp/orchestration/sim.lock`, mkdir/rmdir) and release it.

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

> **Status:** NOT approved — a fix for this already exists; the residual symptom is not yet characterised.

### Triage (AGENTS §1)
- **Known:** this is a residual of `docs/fix/mobile-open-at-end.md` item 1. The mechanism is already in place: `landingStart` (`follow.ts`, `settling: true`), list at `opacity: 0` while `settling` (`SessionScreen.tsx:1754`, style `:2266`), silent non-animated re-scrolls (`landingStep`, `land()` `:597`), reveal timer `LANDING_REVEAL_MS` (`armReveal` `:555`), bounded by `LANDING_ROUNDS = 12` (`follow.ts:238`). The list sets no `initialNumToRender`/`getItemLayout`/`windowSize` (grep), so a FlatList renders the first cells only and the end keeps moving.
- **Unknown:** trigger (cold open vs reopen vs background resync) and magnitude (length-dependent?). Two falsifiable candidates: (H1) the reveal fires before the end stops moving on long transcripts (rounds or quiet window too short) → unit repro in `apps/mobile/test/follow.test.ts`: feed `landingStep`/`landingReveal` a growing height sequence and assert `settling` stays true until a height repeats; (H2) a path bypasses the hidden state (reopen of a mounted screen, `awaiting`, or `landingQuiet` re-attach) → simulator frame capture (take `sim.lock`).
- **Next cheapest test:** H1 unit repro; if green, simulator frames of a cold open of a 300+ row session.

### Owner questions
1. Which trigger shows the travel: cold open from the list, reopening the last session, or return from background? Recommendation: the one you see most; I reproduce that first.
2. If H1/H2 are not the cause, accept a structural fix (render the tail first via `initialScrollIndex` + `getItemLayout`, or `inverted`)? Recommendation: NO until the repro says so — it is L / load-bearing for the follow logic.

*— claude-sonnet-5-5, 2026-11-24*

## Execution

**Repro (H1, unit, `.tentacle/tmp/mobile-open-at-bottom/repro.ts`, unfixed code):**
```
m1 settling true animated false
reveal -> {"settling":false,"silent":false,"revealed":false,...}   # landingDone
growth after reveal: landing step = null
then contentGrew = {"scrollTo":5200,"animated":true}
```
Mechanism proven: when the 120 ms reveal timer fires while the list is still rendering its tail, the OPENING landing hands back to the ordinary follow at once (`landingDone`). The growth its own silent scroll causes then goes to `contentGrew`, ANIMATED — the visible travel. The re-attach path already had the cure (`revealed` silent tail); the opening path did not.

**As built:** `apps/mobile/src/follow.ts` `landingReveal` (opening branch): a hidden `settling` landing now returns the revealed-tail state (`silent`, `revealed`, `last`, `rounds`) instead of `landingDone`, reusing `landingStep`'s revealed branch (silent scrolls until a height repeats, bounded by `LANDING_ROUNDS`; a second quiet reveal hands back). `awaiting` keeps `landingDone` (an existing test pins it). No SessionScreen change: `armReveal`/`land` already re-arm while `landingPending`. Tests in `apps/mobile/test/follow.test.ts`: 3 new, 1 existing assertion updated (reveal state of a long history is now the revealed tail).

**Red → green:** the new "growth after the reveal…" test failed on `grown.step` (null) before the fix. `follow.test.ts` + `session-screen-follow-wiring.test.ts`: 77 pass / 0 fail after. Biome on the two files: clean.

**Mutation:** reverting the branch to `landingDone` makes that test fail (the red run). The other two new tests are boundary pins (bound, second reveal, not-following) and pass on old and new code too.

**Unverified:** that the list→session path is where the quiet window passes mid-growth (busy JS during the navigation transition) was NOT shown — no simulator run. Verify: cold-open a 300+ row session from the session list on the simulator (take `sim.lock`) and watch for travel.

*— claude-sonnet-5-5, 2026-11-24*

## Review

#### Owner answers (2026-11-24)

1. **Only when opening a session FROM THE SESSION LIST** shows the visible scroll (not reopen, not return from background). Use this as the repro trigger: compare the list→session path with the paths that land cleanly (which state/flag does the list path skip or set differently? H2 first).
2. Structural fix (`initialScrollIndex` / `inverted`) — orchestrator applies the recommendation: **no**, unless the repro proves the current hidden-landing mechanism cannot be fixed; then STOP and ask.

**APPROVED** (orchestrator, with the owner's answers): executor Sonnet, red-first repro of the list→session path, Opus review.

*— orchestrator (claude-opus-5-5), 2026-11-24*
