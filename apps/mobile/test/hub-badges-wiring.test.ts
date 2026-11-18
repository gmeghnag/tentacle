/**
 * docs/feat/mobile-hub-badges.md: the hub draws NO dot on the button and NO
 * number bubble on a fan item; a fan item is a SOLID disc with a count rim; news
 * arriving live plays one glow + one light haptic. The components are `.tsx`
 * (unimportable from Bun: React Native's sources are Flow), so this pins the
 * structure from the source — the `hub-native-driver-wiring.test.ts` pattern.
 * What the rules decide is `hub-actions`/`hub-fan`/`haptic-rules`' own tests';
 * this is only that the views draw their answer and the screen wires it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** The source with its comment lines removed: prose may name what the code must not do. */
const code = (...p: string[]) =>
  read(...p)
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

const BUTTON = code("src", "ui", "FloatingActivity.tsx");
const FAN = code("src", "ui", "HubFan.tsx");
const SCREEN = code("src", "screens", "SessionScreen.tsx");

describe("the button has no badge dot any more (owner Q1 C)", () => {
  test("no `hub-badge-dot` node, no `newDot` style, and the running count stays", () => {
    expect(BUTTON).not.toContain("hub-badge-dot");
    expect(BUTTON).not.toContain("newDot");
    // Owner Q1: the running number is not a bubble and is kept.
    expect(BUTTON).toContain('testID="hub-badge-count"');
  });

  test("the button takes a COUNT (never a `HubBadge`, whose dot kind is gone from it)", () => {
    expect(BUTTON).toContain("readonly count: number | null");
    expect(BUTTON).not.toContain("readonly badge:");
    expect(BUTTON).not.toContain("HubBadge");
  });
});

describe("the button glows once when news arrives (Design 5, owner Q1 C)", () => {
  test("a `hub-glow` sibling, driven by a `pulse` counter, not by a mount", () => {
    expect(BUTTON).toContain('testID="hub-glow"');
    expect(BUTTON).toContain("readonly pulse: number");
    // The first mount is a baseline, never a pulse (F1, owner Q3).
    const at = BUTTON.indexOf("const pulseAnim");
    expect(at).toBeGreaterThan(-1);
    const effect = BUTTON.slice(at, BUTTON.indexOf("}, [", at));
    expect(effect).toMatch(/pulse\s*===\s*0|pulse\s*<\s*1|first/);
  });

  test("Reduce Motion drops the scale, keeps the fade (Design 5)", () => {
    // The plan owns the rule (`glowPlan`), the component only applies it.
    const at = BUTTON.indexOf("const pulseAnim");
    const effect = BUTTON.slice(at, BUTTON.indexOf("}, [", at));
    expect(effect).toContain("glowPlan(reduceMotion)");
    expect(BUTTON).toContain("glowPlan(reduceMotion).scale");
  });

  test("the glow is on the native driver, like every other animation of the button", () => {
    const at = BUTTON.indexOf("const pulseAnim");
    const effect = BUTTON.slice(at, BUTTON.indexOf("}, [", at));
    // The plan says `native: true` (its own test), and every step is started with it.
    expect(effect).toContain("useNativeDriver: plan.native");
    expect(effect).toContain(".stopAnimation()");
  });
});

describe("a fan item is a solid disc with a count rim (Designs 6–7–9, owners Q2/Q3)", () => {
  test("no bubble: the count text and the badge pill are gone", () => {
    expect(FAN).not.toContain("styles.badge");
    expect(FAN).not.toContain("badgeText");
    expect(FAN).not.toContain("item.badge.n");
  });

  test("the look comes from `fanItemLook` — the component decides no colour", () => {
    expect(FAN).toContain("fanItemLook(");
    expect(FAN).toContain("palette[look.bg]");
    expect(FAN).toContain("palette[look.fg]");
    // Q3 B: glass is never a disc again.
    expect(FAN).not.toContain("backgroundColor: palette.glass");
  });

  test("the rim is the shared `RingArc`, in the look's tone, only when there is one", () => {
    expect(FAN).toContain("<RingArc");
    expect(FAN).toContain("look.rim");
    expect(FAN).toContain("palette[look.rimTone]");
    // The label pill bled the transcript through too: it is a solid card now.
    expect(FAN).toContain("backgroundColor: palette.card");
  });

  test("the faint dimmed placeholder is gone — dimming is a colour now", () => {
    expect(FAN).not.toContain("DIMMED_OPACITY");
    expect(FAN).not.toContain("Animated.multiply");
  });

  test("VoiceOver reads the rim: the label is `itemA11yLabel`'s, not an inline string", () => {
    expect(FAN).toContain("itemA11yLabel(item)");
    expect(FAN).not.toContain(", nothing running`");
  });
});

describe("the screen wires the pulse (Design 4, failure modes F1–F6)", () => {
  test("it passes a count and a pulse sequence to the button", () => {
    const at = SCREEN.indexOf("<FloatingActivity");
    const props = SCREEN.slice(at, SCREEN.indexOf("/>", at));
    expect(props).toContain("count={buttonBadge(hubBadgeInput)?.n ?? null}");
    expect(props).toContain("pulse={pulseSeq}");
  });

  test("one effect owns the moment: the turn's success, the pulse's light, one haptic (F4)", () => {
    const at = SCREEN.indexOf("const ended = turnEndHaptic(");
    expect(at).toBeGreaterThan(-1);
    const effect = SCREEN.slice(at, SCREEN.indexOf("}, [", at));
    expect(effect).toContain("pulseHaptic(");
    // The verdict the two halves share is computed ONCE, from the same render.
    expect(effect).toContain("ended !== null");
    expect(effect).toContain("setPulseSeq");
  });

  test("the baseline resets on a session switch and on a link drop, in the one step that compares (F1, F2)", () => {
    expect(SCREEN).toContain("useRef<PulseState>(PULSE_START)");
    // ONE effect: a separate reset effect runs BEFORE the comparison in a commit
    // and the comparison re-advances the baseline, which made both resets dead.
    const at = SCREEN.indexOf("const ended = turnEndHaptic(");
    const block = SCREEN.slice(at, SCREEN.indexOf("}, [", at));
    // The switch (F1) and the drop (F2) are INPUTS of the step, not sibling effects.
    expect(block).toContain("sessionKey: artifactsSeenKey");
    expect(block).toContain('link: linkUp ? "up" : "down"');
    // The dead pattern: a reset effect of its own outside the comparison.
    expect(SCREEN).not.toMatch(/pulsePrev\.current = null/);
  });

  test("the baseline advances on every render the rule sees — the verdict never sees `floatShown` (F3)", () => {
    const at = SCREEN.indexOf("const ended = turnEndHaptic(");
    const block = SCREEN.slice(at, SCREEN.indexOf("}, [", at));
    // The glow and the light are gated on the button being shown...
    expect(block).toContain("pulseHaptic(step.pulse && floatShown");
    expect(block).toContain("step.pulse && floatShown");
    // ...but the STEP (which re-takes the baseline) does not: the reading is its
    // input, so the news is consumed and never replayed when the button returns.
    expect(block).toContain("news: { unseenArtifacts: unseen, unreadReport: unread }");
    // ONE write per render: the step's own next state, unconditionally. A write
    // inside the `floatShown` branch would restore an older baseline (deferring
    // the glow to when the button returns — exactly what F3 forbids).
    expect([...block.matchAll(/pulsePrev\.current\s*=/g)]).toHaveLength(1);
    expect(block).toContain("pulsePrev.current = step.state");
    expect(block).not.toMatch(/pulseStep\([^)]*floatShown/);
    expect(block).not.toContain("deferred");
  });
});
