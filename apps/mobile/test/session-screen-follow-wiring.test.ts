/**
 * docs/fix/mobile-chat-glitches.md — the component halves of bugs 1 and 3 and
 * items 5/6. The decisions are pure and tested elsewhere (`follow.test.ts`,
 * `session-screen-compose.test.ts`); these files import React Native, so their
 * wiring is pinned as SOURCE (the `field-reveal.test.ts` pattern).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]): string =>
  readFileSync(join(import.meta.dir, "..", "src", ...parts), "utf8");

describe("SessionScreen follow wiring (bug 3: the TRUE end, padding included)", () => {
  const src = read("screens", "SessionScreen.tsx");

  test("no RN `scrollToEnd` (its target is the last cell's end, 16 pt short)", () => {
    expect(src).not.toContain("scrollToEnd(");
  });

  test("it scrolls to the offset `follow.ts` names", () => {
    expect(src).toMatch(
      /step\.scrollTo !== null\)[\s\S]{0,120}scrollToOffset\(\{ offset: step\.scrollTo/,
    );
  });

  test("the native content height feeds `contentGrew`, the list's layout feeds `viewportChanged`", () => {
    expect(src).toMatch(/\(_width: number, height: number\)[\s\S]{0,700}contentGrew\(/);
    expect(src).toMatch(/onContentSizeChange=\{onContentSize\}/);
    expect(src).toMatch(/onListLayout = useCallback\([\s\S]{0,300}viewportChanged\(/);
    expect(src).toMatch(/<FlatList[\s\S]*onLayout=\{onListLayout\}/);
  });
});

describe("SessionScreen hidden landing batch (docs/fix/mobile-open-long-session-3.md)", () => {
  const src = read("screens", "SessionScreen.tsx");

  test("the FlatList's maxToRenderPerBatch is `landingBatch(settling)`, never a constant", () => {
    expect(src).toMatch(/<FlatList[\s\S]{0,200}maxToRenderPerBatch=\{landingBatch\(settling\)\}/);
    expect(src).toMatch(
      /import \{[\s\S]{0,400}landingBatch,[\s\S]{0,400}\} from "\.\.\/follow\.ts"/,
    );
  });
});

describe("RenameSheet (bug 1: the dialog sits above the keyboard, with a top inset)", () => {
  const src = read("screens", "RenameSheet.tsx");

  test("a KeyboardAvoidingView INSIDE the Modal (a Modal is its own window)", () => {
    expect(src).toMatch(
      /<Modal[\s\S]*<KeyboardAvoidingView[\s\S]*<\/KeyboardAvoidingView>[\s\S]*<\/Modal>/,
    );
  });

  test("the card has a non-zero top inset, and the title's Dynamic Type is capped", () => {
    expect(src).toMatch(/card: \{[^}]*paddingTop: [1-9]/);
    expect(src).toMatch(/maxFontSizeMultiplier=\{DENSE_FONT_SCALE\}[\s\S]{0,120}Rename session/);
  });
});

describe("items 5/6: a send dismisses the keyboard and remounts the field", () => {
  test("SessionScreen: `Keyboard.dismiss()` in an effect keyed on the sends figure", () => {
    const src = read("screens", "SessionScreen.tsx");
    expect(src).toMatch(
      /useEffect\([\s\S]{0,300}Keyboard\.dismiss\(\)[\s\S]{0,200}\[rowsSlice\.sends\]\)/,
    );
    // The field is `ComposerPane`'s, keyed on its slice's `sends`.
    const pane = read("screens", "session", "ComposerPane.tsx");
    expect(pane).toMatch(/<Composer[\s\S]{0,200}fieldKey=\{slice\.sends\}/);
  });

  test("Composer: `key={fieldKey}` on the composer-input TextInput", () => {
    const src = read("ui", "Composer.tsx");
    expect(src).toMatch(/<TextInput\s+key=\{fieldKey\}\s+testID="composer-input"/);
  });
});

describe("SessionScreen: a session opens ALREADY at its end (docs/fix/mobile-open-at-end.md, item 1)", () => {
  const src = read("screens", "SessionScreen.tsx");

  test("the performed scroll takes its `animated` from the step (never a hard `true`)", () => {
    expect(src).toMatch(/scrollToOffset\(\{ offset: step\.scrollTo, animated: step\.animated \}\)/);
    expect(src).not.toMatch(/scrollToOffset\(\{ offset: step\.scrollTo, animated: true \}\)/);
  });

  test("both measurements go through the landing first, and it owns the scroll while pending", () => {
    expect(src).toMatch(/onContentSize = useCallback\([\s\S]{0,400}if \(land\(\)\) \{/);
    expect(src).toMatch(/onListLayout = useCallback\([\s\S]{0,300}if \(land\(\)\) \{/);
    expect(src).toMatch(
      /landingStep\(\s*landing\.current,[\s\S]{0,140}hasRows\.current,\s*offset\.current,?\s*\)/,
    );
    expect(src).toMatch(/const landing = useRef<Landing>\(landingStart\)/);
  });

  test("the list is HIDDEN while it lands (a long history is never seen scrolling) [mutation: drop the style → visible scroll]", () => {
    expect(src).toMatch(/<View style=\{settling \? styles\.hidden : styles\.screen\}>/);
    expect(src).toMatch(/hidden: \{ flex: 1, opacity: 0 \}/);
  });

  test("a re-attach (pull, Retry, Reopen, a foreground return) lands SILENTLY: no second visible scroll", () => {
    // ONE helper, so the four re-attach sites cannot drift apart (Review round 1,
    // MEDIUM 3: the foreground return was the one that did).
    expect(src).toMatch(/landing\.current = reattachLanding\(followRef\.current\.following\)/);
    expect(src).not.toMatch(/landing\.current = followRef\.current\.following \?/);
    // The pull, the Retry row, the Reopen button and the foreground return.
    expect(src.match(/landing\.current = reattachLanding\(/g) ?? []).toHaveLength(4);
  });

  test("the app's foreground transition reaches the controller, and only an ACTUAL re-attach re-arms the landing (item 2, Review round 1 MEDIUM 3)", () => {
    expect(src).toMatch(
      /AppState\.addEventListener\("change"[\s\S]{0,900}controller\.appState\(next\)/,
    );
    // `appState` returns whether it STARTED a re-attach: arming on a duplicate
    // `active` (iOS sends two) would arm a landing nothing lands.
    expect(src).toMatch(/if \(controller\.appState\(next\)\) \{/);
  });

  test("the hidden landing is REVEALED on a quiet timer, not only on a repeated measurement (Review round 1, HIGH 1)", () => {
    // `settling` used to end only when two measurements saw the same height, and
    // RN fires a content/layout event only on a CHANGE — so a short session never
    // repeated one and the list stayed invisible.
    expect(src).toMatch(
      /landingReveal\(\s*landing\.current,\s*size\.current,\s*followRef\.current\.following,\s*hasRows\.current,\s*offset\.current,?\s*\)/,
    );
    expect(src).toMatch(/setTimeout\(\(\) => \{[\s\S]{0,900}LANDING_REVEAL_MS\)/);
    // Every landing scroll re-arms it: the reveal waits for the measurements to
    // go quiet, so it never chops a landing loop in half.
    expect(src).toMatch(/armReveal\(\);[\s\S]{0,120}if \(changed\) \{/);
    // Armed at the mount too: an EMPTY (or one-short-message) list sends no
    // measurement at all, and the empty state is inside the hidden View.
    expect(src).toMatch(/useEffect\(\(\) => \{\s*armReveal\(\);\s*\}, \[armReveal\]\)/);
    // Unmounted while landing: the timer never fires into a gone screen.
    expect(src).toMatch(/useEffect\(\(\) => disarmReveal, \[disarmReveal\]\)/);
  });

  test("a landing decides 'nothing to land YET' from the ROWS, never from the content height (Review round 2, NEW HIGH)", () => {
    // A content height cannot answer it: the empty list's `flexGrow: 1` makes it
    // report about the VIEWPORT, so a slow attach looked already settled and the
    // history that then arrived went through `contentGrew` ANIMATED.
    expect(src).toMatch(
      /hasRows\.current = rowsSlice\.view\.rows\.length > 0 \|\| rowsSlice\.status\.phase !== "opening"/,
    );
    // Both measurements pass it (the reveal is what settled the empty state).
    expect(src).toMatch(
      /landingStep\(\s*landing\.current,[\s\S]{0,140}hasRows\.current,\s*offset\.current,?\s*\)/,
    );
    expect(src).toMatch(
      /landingReveal\(\s*landing\.current,[\s\S]{0,140}hasRows\.current,\s*offset\.current,?\s*\)/,
    );
  });
});

/**
 * Review round 1, finding 1: the SCREEN half of bug 4's fix had no test of its
 * own — `follow.test.ts` copies the screen's routing instead of asserting it — so
 * putting back the pre-fix `return next.step !== null` (and re-arming the reveal
 * only when the measurement scrolled) stayed green while restoring the loop.
 */
describe("the screen routes a landing through `landingPending`, not 'did it scroll?' (bug 4)", () => {
  const src = read("screens", "SessionScreen.tsx");

  test("`land()` returns the landing's verdict AND re-arms the reveal whenever one is owed", () => {
    // A re-attach ABSORBS its measurements without scrolling, so "did this one
    // scroll?" is `false` for it: that verdict sent the next measurement through
    // `contentGrew` — ANIMATED, the owner's loop — and never re-armed the timer
    // that lands the absorbed landing.
    expect(src).toMatch(/if \(landingPending\(next\.state\)\) \{\s*armReveal\(\);\s*\}/);
    // The consumed measurement is the landing's too: the one that ENDS it repeats
    // the height its own silent scroll already reached (an animated scroll to that
    // offset is the loop's echo) — decided by `follow.ts`, `following` included
    // (Review round 2, finding 3: a bare `owed ||` swallowed the "new below" pill).
    expect(src).toMatch(/const before = landing\.current;/);
    expect(src).toMatch(
      /return landingOwns\(before, next\.state, followRef\.current\.following\);/,
    );
    expect(src).not.toMatch(/return owed \|\|/);
    // The pre-fix line, and any equivalent of it, is gone for good.
    expect(src).not.toMatch(/return next\.step !== null;/);
    expect(src).not.toMatch(/if \(next\.step !== null\) \{\s*armReveal\(\);/);
    expect(src).toMatch(/landingOwns,[\s\S]{0,200}\} from "\.\.\/follow\.ts"/);
  });

  test("the reveal re-arms itself while the landing it landed is still owed (the hand-over after a re-attach)", () => {
    // A re-attach whose scroll caused NO re-measure gets no further `land()` call:
    // without this second, quiet fire the landing stayed owed for ever, and the
    // next row a stream appended was absorbed (silent) instead of followed.
    expect(src).toMatch(
      /if \(next\.step !== null && landingPending\(next\.state\)\) \{\s*fire\(\);\s*\}/,
    );
    expect(src).toMatch(/const fire: \(\) => void = \(\) => \{\s*reveal\.current = setTimeout/);
    expect(src).toMatch(/reveal\.current = null;[\s\S]{0,300}landingReveal\(/);
  });

  test("both measurements ask `land()` first and RETURN when it owns the list (no fall-through to the animated follow)", () => {
    expect(src).toMatch(
      /onContentSize = useCallback\([\s\S]{0,500}if \(land\(\)\) \{\s*return;\s*\}/,
    );
    expect(src).toMatch(
      /onListLayout = useCallback\([\s\S]{0,400}if \(land\(\)\) \{\s*return;\s*\}/,
    );
    // The builder's own `next.state` is what is asked, before it is dropped.
    expect(src).toMatch(/const next = landingStep\([\s\S]{0,300}landing\.current = next\.state;/);
  });
});

describe("the settle re-check (docs/fix/mobile-qa-1117.md, bug 5)", () => {
  const src = read("screens", "SessionScreen.tsx");

  test("every content or viewport change re-arms it, after its own follow step", () => {
    expect(src).toMatch(/perform\(contentGrew\([^)]*\)\);\s*armSettle\(\);/);
    expect(src).toMatch(/perform\(viewportChanged\([^)]*\)\);\s*armSettle\(\);/);
  });

  test("it reads the list's real offset and lets `settleStep` decide; a drag skips it", () => {
    expect(src).toContain("offset.current = contentOffset.y;");
    expect(src).toMatch(
      /settleStep\(\s*followRef\.current,\s*\{ offset: offset\.current, \.\.\.size\.current \},\s*!silent,?\s*\)/,
    );
    // fix/mobile-open-long-session: a landing that ENDS arms ONE silent settle check,
    // from both of its exits (a measurement and the reveal timer).
    expect(src).toContain("armLandedSettle.current = () => armSettle(true);");
    expect(src.match(/armLandedSettle\.current\(\)/g)?.length).toBe(2);
    expect(src).toMatch(/if \(dragging\.current\) \{\s*return;\s*\}\s*const step = settleStep/);
  });
});

/**
 * Owners 2 and 5 (docs/feat/mobile-hub-center.md): the hub FLOATS. The footer no
 * longer reserves its column — `footClearance`/`HUB_COLUMN` are gone — so a queued
 * bubble lines up with a sent one (`space.inset`, the transcript row's gutter)
 * instead of being squeezed away from the screen's edge.
 */
describe("the transcript's foot no longer reserves the hub's column (owners 2/5)", () => {
  const src = read("screens", "SessionScreen.tsx");

  test("the screen neither imports nor passes `footClearance`", () => {
    expect(src).not.toContain("footClearance");
    expect(src).not.toMatch(/clearance=/);
  });

  test("the pending row pads with the transcript's own inset (O6)", () => {
    const footer = read("screens", "compose", "PendingBubble.tsx");
    expect(footer).not.toContain("clearance");
    expect(footer).toMatch(
      /<View style=\{\[styles\.row, \{ paddingHorizontal: space\.inset \}\]\}>/,
    );
  });

  test("the open menu still pairs its state (a regression I introduced and reverted)", () => {
    const footer = read("screens", "compose", "PendingBubble.tsx");
    expect(footer).toMatch(/const \[open, setOpen\] = useState<string \| null>\(null\);/);
    expect(footer).toMatch(/onToggle=\{\(\) => setOpen\(/);
    expect(footer).not.toMatch(/useState<string \| null>\(null\)\[1\]/);
  });
});

/**
 * Owner 2 B (docs/feat/mobile-hub-center.md D4): a scroll the FINGER makes fades
 * the hub to 20 % and lets taps through; the transcript's own follow-scroll must
 * not. The reducer is `hub-scroll-dim.ts` (tested there); this pins the wiring —
 * the FOUR handlers, never `onScroll`, and the reset when the button hides.
 */
describe("the scroll dim's handlers (owner 2 B)", () => {
  const src = read("screens", "SessionScreen.tsx");
  const handler = (name: string): string => {
    const at = src.indexOf(`${name}={() => {`);
    return at === -1 ? "" : src.slice(at, at + 200);
  };

  test("the two begins dispatch `begin`, beside the `dragging` writes", () => {
    expect(handler("onScrollBeginDrag")).toMatch(/scrollEvent\("begin"\)/);
    expect(handler("onMomentumScrollBegin")).toMatch(/scrollEvent\("begin"\)/);
    expect(handler("onScrollBeginDrag")).toContain("dragging.current = true;");
  });

  test("the two ends dispatch `end`", () => {
    expect(handler("onScrollEndDrag")).toMatch(/scrollEvent\("end"\)/);
    expect(handler("onMomentumScrollEnd")).toMatch(/scrollEvent\("end"\)/);
    expect(handler("onScrollEndDrag")).toContain("dragging.current = false;");
  });

  test("`onScroll` dispatches NOTHING: a streaming turn's follow-scroll never dims the hub", () => {
    const at = src.indexOf("const onScroll = useCallback(");
    const body = src.slice(at, src.indexOf("const onContentSize", at));
    expect(body).toContain("scrolled(");
    expect(body).not.toContain("scrollEvent(");
  });

  test("the button hides → `reset`, so a sheet that covered it mid-scroll cannot leave it dimmed", () => {
    expect(src).toMatch(/if \(!floatShown\) \{\s*scrollEvent\("reset"\);\s*\}/);
  });

  test("ONE timer, cleared on unmount; the state comes from the pure reducer", () => {
    expect(src).toMatch(/scrollDimStep\(scrollDimState\.current, event\)/);
    expect(src).toMatch(/SCROLL_REST_MS\)/);
    expect(src.match(/scrollDimTimer\.current = setTimeout\(/g) ?? []).toHaveLength(1);
    expect(src).toMatch(
      /if \(scrollDimTimer\.current !== null\) \{\s*clearTimeout\(scrollDimTimer\.current\)/,
    );
  });

  test("the screen hands the dim to the button, and the button takes it as a prop", () => {
    expect(src).toMatch(/<HubPane[\s\S]{0,1200}scroll=\{scrollDim\}/);
    expect(src).toMatch(
      /import \{[\s\S]{0,200}scrollDimStep,[\s\S]{0,200}\} from "\.\.\/hub-scroll-dim\.ts"/,
    );
    const button = read("ui", "FloatingActivity.tsx");
    expect(button).toMatch(/readonly scroll: ScrollDim;/);
    expect(button).toMatch(/hubPresence\(\{/);
  });
});

/**
 * Owner 6 (docs/feat/mobile-hub-center.md D6): the list's end padding is a
 * SETTING — on by default (today's behaviour), off = the plain 16 pt. The default
 * lives in ONE place (`listEndOn`), never at the call site.
 */
describe("the list's end padding is a setting (owner 6)", () => {
  const src = read("screens", "SessionScreen.tsx");

  test("the screen passes `listEndPadding`'s `enabled` from `listEndOn(activitySettings)`", () => {
    expect(src).toMatch(/listEndPadding\(\{[\s\S]{0,200}enabled: listEndOn\(activitySettings\)/);
    expect(src).toContain('import { listEndOn } from "../activity-settings-store.ts";');
  });
});
