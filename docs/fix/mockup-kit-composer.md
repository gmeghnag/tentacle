# fix/mockup-kit-composer — the mockup kit's composer, hub and Polpetto match the app

Type: fix · Size: S · Blast: contained (`tools/mockup-kit/`, `scripts/mockup-kit/` only — never shipped in the app or the CLI) · Suited: Opus review

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Owner 23/11 ~11:25 on the composer-hub mockup v1: «si vede malissimo, renderizzato brutto». Cause (verified with headless screenshots against the owner's real-app screenshot): the kit's `composer` drew + / mic as bare glyphs and ↑ as a light disc while the app puts + and mic in filled `accentSoft` circles (`apps/mobile/src/ui/Composer.tsx:257`); the hub button and Polpetto's palette diverged too. The mockup redo (Opus, 23/11 11:29–11:41) fixed the KIT at the source instead of drawing around it, so every future mockup inherits it. Owner 23/11 ~12:15: «fallo partire ora in parallelo» (review + merge).

## Implementation

Already executed by the mockup agent (commits on this branch): `tools/mockup-kit/kit.js` (composer: accentSoft circles, slot rules; hub glass + cyan dots; new `K.polpetto`), `tools/mockup-kit/kit.css` (`:691,704,723` hub; composer styles), `scripts/mockup-kit/sources.ts:~258` (Polpetto generated from the app's mascot source). The agent reported: kit tests 27/27, lint clean, typecheck clean. Known approximations left: icon glyphs (+ / mic / ↑ / clock), hub blur strength, fan shows letters.

## Execution

*— claude-opus-5-5 (mockup designer), 2026-11-23 — see the commits; no separate executor run.*

### Fix round 1

*— claude-opus-5-5 (executor, fix round 1), 2026-11-23*

Both findings fixed, no production code changed outside them: the kit's markup and
look are untouched, `kit.js`/`kit.css` gained only comments (verified: `git diff
tools/mockup-kit/kit.css` is two comment blocks, `kit.js` unmodified).

**Finding 1 (MEDIUM, no regression test) — FIXED.** `scripts/test/mockup-kit.test.ts`
gained two describes (10 tests, none touching shipped code):

- *the composer's faces* — + and the mic are `k-circle`s holding `k-sym` SVGs (the
  emoji is asserted absent), the four slot faces (`ready` / `up-dim` / `stop` /
  `clock` at 17 pt) are distinguished, listening is `[data-strong]` + `k-rec-square`,
  finalizing an arc, `caption` and `K.composerParts` reuse the same markup, and
  `K.icon` throws on an unknown symbol. Plus the LOOK: `.k-circle` is painted
  `background: var(--c-accent-soft)`, `color: var(--c-accent)`, `[data-strong]` the
  strong variant — a correct-markup/wrong-look regression is caught too.
- *Polpetto* — the still frame's rects are compared element-by-element
  (`toEqual`) with `pixels(stillFrame(), {SPRITE_PT, SPRITE_PT+HOME_INSET_PT},
  colorsFor("mint"))` imported from the app, i.e. the kit is pinned to the app's
  own output; every frame's rects lie inside its declared svg box and its sprite
  bottom lands on `HOME_INSET_PT` (the overhang lift); an unknown frame throws
  naming the two that exist.

Evidence the tests hold (§9 non-vacuity). RED first, against `main`'s kit.js +
kit-data.json dropped in place: 8 fail (`+ and the mic…`, `the four slot faces…`,
`listening…`, `the circle is painted…`, `caption…`, both Polpetto rects/geometry
tests, `an unknown frame throws`) with assertion errors, not import errors — the
`K.icon`/`K.polpetto`/`composerParts` names do not exist on main. Then restored →
all green.

Mutation checks (each applied to the branch's file, test run, file restored from a
saved pristine copy):

| # | Mutation | Killed by |
|---|---|---|
| M1 | `SLOT.send` back to a bare `↑` | `the four slot faces differ` |
| M2 | `composerParts.plus` back to a bare `+` | `+ and the mic are filled k-circles`, `caption/composerParts` |
| M3 | `MIC.idle` back to the 🎙︎ emoji | same two |
| M4 | `polpetto` recolours `still` (`#7B3FC0`, the soft palette) | `the still frame's rects are pixels(stillFrame())` |
| M5 | drop the overhang lift (`bottom: inset ?? homeInset`) | `every frame sits HOME_INSET_PT above…` |
| M6 | remove the unknown-frame guard | `an unknown frame throws…` |
| M7 | `clock` loses its `size: 17` | `the four slot faces differ` |
| M8 | drop the `caption` span | `caption and K.composerParts…` |
| M11 | `.k-circle` loses its `accentSoft` fill | `the circle is painted accentSoft…` |
| M13 | `rects.slice(1)` — one mascot rect dropped | `the still frame's rects are…` |

**Finding 2 (MEDIUM, `calc(12 * 1px)` evades the no-literal rule) — FIXED, both
halves.** Extracted AND caught, because either alone is weak:

- `scripts/mockup-kit/kit-rules.ts:63` `literalViolations` now also flags
  `calc(<number> * 1px)`; a TOKEN times 1px (`calc(var(--m-x) * 1px)`, the kit's
  normal unit conversion, e.g. `kit.css:93`) does not match and stays legal.
- New `APPROXIMATIONS` (`kit-rules.ts:51`) is a named, published list
  (`declaration` + `why`), and the rule exempts only an exact declaration match.
  The one entry is the hub's `backdrop-filter: blur(calc(12 * 1px)) saturate(1.4)`,
  whose `why` cites `FloatingActivity.tsx:563` (inline-JSX `BlurView intensity={60}`,
  a native material with no CSS equivalent).
- Tests: `a hand-picked size dressed as a hairline…` (the rule catches `12 * 1px`
  and `13.5 * 1px`, allows the token form) and `the kit's approximations are named,
  narrow, and each is in the CSS` (every entry carries a `why` and appears in
  `kit.css`; the same declaration at `14 * 1px` or without its `saturate(1.4)` is
  still a violation, so the exemption is exact, not a prefix; an entry absent from
  the CSS fails).
- Doc surface kept in sync: the `kit.css` header rule, the approximation's own
  comment, and `tools/mockup-kit/README.md`'s row now name `APPROXIMATIONS`.

RED/mutations for finding 2: the `calc` test fails on the old rule (assertion, not
an import error). M9 (remove the `calc` matcher) → both finding-2 tests red. M10
(widen the exemption to `declaration.startsWith("backdrop-filter:")`) → red, after I
sharpened the narrowness assertion: my first version used a `.x { … }` one-liner,
which M10 survived — a real weakness (the exemption compares a whole trimmed
declaration, so it needs a real declaration line to test). M12 (a second, unlisted
`padding: calc(7 * 1px)`) → red with `683: calc(7 * 1px)`.

Gate on the touched scope: `bun test scripts/test/mockup-kit.test.ts
scripts/test/mockup-kit-png.test.ts` → **44 pass / 0 fail**; `bunx biome check` on
the changed TS/CSS files → clean; `bunx tsc --noEmit` → clean. The full `bun run
check` is the orchestrator's, run after this round.

Unverified (one line): the rendered look was not re-screenshotted — these tests pin
the markup, the tokens and the app's own rects, not pixels on screen; calibration
(`bun scripts/mockup-kit.ts calibrate`, needs Chrome + an e2e run) is how to check
that.

## Review

**Verdict: REQUEST-CHANGES.**

Gate (touched files): `bun test scripts/test/mockup-kit.test.ts scripts/test/mockup-kit-png.test.ts` 34 pass / 0 fail; `bun run lint` clean; `bun run typecheck` clean. Full `bun test` not re-run (contained, kit-only diff).

Findings:
1. **MEDIUM — no regression test for the fix (AGENTS §4/§9).** `git diff main...HEAD` touches no test; nothing references `K.polpetto`, `K.icon`, `composerParts`, `caption`, `.k-circle`'s `accentSoft` or the new slot faces. Failure scenario: reverting `tools/mockup-kit/kit.js:213-290` to the old bare `+`/🎙︎/light-disc markup (the exact owner-reported defect) keeps all 34 tests green. Needed: a test that pins the composer's + / mic in a `k-circle`, the four slot faces, `polpetto` rects = `pixels(stillFrame())` and its unknown-frame throw — shown red on `main`.
2. **MEDIUM — `tools/mockup-kit/kit.css:691` `blur(calc(12 * 1px)) saturate(1.4)` evades the kit's no-literal-px rule** (`scripts/mockup-kit/kit-rules.ts:51-56` exempts `1px`, so `12 * 1px` passes). A hand-picked number enters the "generated from source" kit disguised as a hairline; the next agent copies the trick. Either extract/declare it as a named, documented approximation token, or extend `literalViolations` to catch `calc(N * 1px)` and allowlist this one line explicitly.

Attacks tried: (a) every new `var(--…)` (`c-sep`, `c-fill`, `c-accent-soft[-strong]`, `c-page`, `m-composer-flex-flex`, `m-composer-rec-square-*`, `m-composer-caption-min-width`) exists in `generated/tokens.css` — holds (also the existing defined-vars test). (b) e2e trace (scratch `r.ts`): `polpetto` still = 34 rects 54×54, bottom 76 = `HOME_INSET_PT`; skate has `minX −6` handled by `x0`, `minY 0` so the un-handled negative-y case is latent only; geometry `{SPRITE, SPRITE+INSET}` gives home (0,0) per `mascot-scenes.ts:113-118` — holds. (c) TDZ: `composer()` reads `composerParts` declared after it, but only at call time; `SLOT`/`MIC` call hoisted `icon()` after `ICON`/`WEIGHT` — holds. (d) `kit-data.json` drift vs source — "no drift" test green. (e) `kit.d.ts` not updated, but `[component: string]: unknown` covers new builders — no type break.

Premises: `Composer.tsx:257` accentSoft circles — not opened (style claim, see finding 1: nothing pins it). Mutation: not run for new tests (none exist); finding 1 is the vacuity.

Executor behaviour: fixed the kit at the source (good), honest about approximations in the doc, but shipped without a test and bypassed a kit rule rather than surfacing it. Reviewer is the same model family as the executor (fresh context only).

*— claude-opus-5-5, 2026-11-23*

### Round 2

**Verdict: APPROVE.** Reviewed `git diff HEAD~1` (11918d6b).

- **Finding 1 (no regression test) — resolved.** 8 new tests (composer faces, `accentSoft` paint, `caption`/`composerParts`/`K.icon` throw, Polpetto = `pixels(stillFrame())`, inset/no-clip, unknown frame). Mutations, each reverted: `composerParts.plus` → bare `<span class="k-hit">+</span>` ⇒ 3 fail; `.k-circle` `background: var(--c-accent-soft)` removed ⇒ "painted accentSoft" fails; Polpetto `x="${r.x - x0}"` → `${r.x}` ⇒ "nothing clipped" fails.
- **Finding 2 (calc(12 * 1px) evasion) — resolved.** `literalViolations` now matches `calc(N * 1px)`; the one blur is a named, exact-match entry in `APPROXIMATIONS` (`scripts/mockup-kit/kit-rules.ts:51`). Mutations: drop the calc regex ⇒ 2 fail; entry number 12→11 (CSS unchanged) ⇒ 3 fail (the literal resurfaces, and the "each is in the CSS" check fires).
- Regressions: the exemption is an exact trimmed-declaration match (a different number or a dropped `saturate` is not exempt — pinned by the test); `calc(var(--m-x) * 1px)` is still allowed. Tree byte-identical after the mutations (`git status` clean).
- Gate: kit tests 44 pass / 0 fail (2 files); `bun run lint` clean; `bun run typecheck` clean. Full `bun test` not re-run (kit-only diff).
- Same model family as the round-1 executor-reviewer pairing caveat holds; round-2 executor was a different model (deepseek).

*— claude-opus-5-5, 2026-11-23*
