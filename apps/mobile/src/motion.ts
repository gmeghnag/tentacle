/**
 * The app's animation timings that used to be inline literals in components
 * (docs/feat/mobile-mockup-kit.md Slice 1a): one named, exported constant per
 * timing, so the mockup kit's generator (`scripts/mockup-kit.ts`) reads every
 * one BY NAME and a mockup can never re-guess them. Pure: no React, no imports.
 *
 * Timings that already lived in a pure module stay there (`thinking-motion.ts`
 * `BREATHE_MS`/`SHIMMER_MS`, `hub-flash.ts` `FLASH_MS`, `floating-button.ts`
 * `FADE_MS`, `follow.ts` `SETTLE_MS`, `chart-interact.ts` `DRAW_MS`…). A new
 * component animation adds its constant HERE: `test/motion-literals.test.ts`
 * fails on a numeric `duration:` / `delay:` / `setInterval` period in a
 * component.
 */

/**
 * Half of a running step's blink (`ui/StepNode.tsx` `BlinkingDot`): ON this long,
 * then OFF as long — the TUI's `BLINK_HALF_MS` (`packages/tui/src/blink.ts`),
 * pinned equal by `test/step-blink.test.ts` (docs/fix/mobile-running-row.md).
 */
export const STEP_BLINK_HALF_MS = 500;
/**
 * The tick of a running step's elapsed clock: the native view ticks once a second
 * (`modules/tentacle-clock/ios/ClockTextView.swift`), and so does the workflow
 * run's (`run-clock.ts`).
 */
export const STEP_ELAPSED_TICK_MS = 1000;
/**
 * How often the JS clocks look at the time (`use-since.ts`: the fallback label and
 * the Thinking row's spoken one). A row re-renders only when its label changes;
 * 4× a second, so no second is skipped or shown twice whatever its origin's phase.
 */
export const CLOCK_SAMPLE_MS = 250;
/** Half of the header dot's pulse, 1 → 0.3 or back (`ui/HeaderDot.tsx`): 1.4 s a cycle. */
export const HEADER_DOT_HALF_MS = 700;
/** The header dot pulse's easing, named for the kit (`Easing.inOut(Easing.ease)`). */
export const HEADER_DOT_EASING = "inOut(ease)";
/** The header dot pulse's low point (opacity). */
export const HEADER_DOT_LOW_OPACITY = 0.3;
/** The dictation halo's one breath, 32 → 42 pt (`ui/Composer.tsx` `Halo`). */
export const COMPOSER_HALO_MS = 1200;
/** One turn of the composer's transcribing arc (`ui/Composer.tsx`). */
export const COMPOSER_TRANSCRIBE_TURN_MS = 900;
/** One turn of the floating hub button's running-turn arc (`ui/FloatingActivity.tsx`). */
export const FLOATING_ARC_TURN_MS = 1200;
/** The activity sheet's resize under Reduce Motion (`screens/ActivitySheet.tsx`). */
export const ACTIVITY_SHEET_RESIZE_MS = 150;
/** The tick of the activity panel's relative times (`screens/SessionScreen.tsx`). */
export const ACTIVITY_CLOCK_TICK_MS = 1000;
/** The hub button's news glow: up to its peak (`hub-button-motion.ts` `glowPlan`). */
export const HUB_GLOW_IN_MS = 220;
/** The hub button's news glow: back to nothing. */
export const HUB_GLOW_OUT_MS = 480;
/** The sessions drawer's slide (`drawer-nav.ts` `drawerMotion`). */
export const DRAWER_MS = 220;
